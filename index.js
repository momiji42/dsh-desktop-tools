// Host half of dsh-desktop-tools.
//
// One bundle row owns two desktop controls that share nothing but their home:
//
//   * restart   - replace the running desktop app, so a plugin bundle installed
//                 a moment ago is actually loaded afterwards. The handoff is
//                 done out-of-process by a detached helper (see lib/helper.js);
//                 the Host is a plain Node child of Electron and cannot call
//                 `app.relaunch()` itself.
//   * autostart - the per-user HKCU Run entry that launches the desktop app when
//                 Windows signs in. The desktop build has no "start with Windows"
//                 preference of its own.
//
// Routes (same-origin only; the destructive POST additionally requires JSON):
//
//   GET  /api/dsh-desktop-tools/status     - readiness of both capabilities
//   POST /api/dsh-desktop-tools/restart    - replace the running application
//   POST /api/dsh-desktop-tools/autostart  - create/remove the sign-in entry
//
// Killing the whole application is the most destructive thing a plugin can do,
// so the restart POST is guarded twice: the caller must be loopback and
// same-origin, and it must send `application/json`, which a cross-site page
// cannot do without a preflight this server does not answer. The autostart POST
// goes through the same guard: writing a Run entry is also a machine-level
// change, and a cross-origin page must never be able to do it.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAutostartState, writeAutostartState } from './lib/autostart.js'
import { HANDOFF_DELAY_MS, buildHelperSource } from './lib/helper.js'
import { inspectDesktopTarget, readiness } from './lib/target.js'

/** Stable plugin name; the loader row id is `desktop-tools`. */
export const name = 'desktop-tools'

/** The browser carrier that serves the routes the Client half calls. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/api/dsh-desktop-tools'
const STATUS_ROUTE = `${ROUTE_PREFIX}/status`
const RESTART_ROUTE = `${ROUTE_PREFIX}/restart`
const AUTOSTART_ROUTE = `${ROUTE_PREFIX}/autostart`

/** Headers that prove a request was proxied; a destructive call must never cross one. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto']

const MAX_BODY_BYTES = 4096

/**
 * Mount both capabilities.
 *
 * @param ctx - the plugin context.
 * @param config - optional `{ handoffDelayMs }`, mostly for tests.
 */
export function apply(ctx, config = {}) {
  const bootId = randomUUID()
  const startedAt = Date.now()

  // Resolved once per mount: the process this plugin lives in does not change.
  const target = inspectDesktopTarget({
    env: process.env,
    execPath: process.execPath,
    exists: existsSync,
  })
  const verdict = readiness({
    target,
    platform: process.platform,
    hostPid: process.pid,
    parentPid: process.ppid,
  })

  // Single-flight latch. `restarting` is set before the helper is spawned and is
  // never cleared: after a successful handoff this process is about to die, and
  // a second request in the meantime must not start a second helper.
  let restarting = false
  let lastError = null

  const restartState = () => ({
    ready: verdict.ready,
    reason: verdict.reason,
    detail: verdict.detail ?? null,
    executable: verdict.executable ?? null,
    hostPid: process.pid,
    electronPid: verdict.electronPid ?? null,
    restarting,
    lastError,
  })

  /** The combined status payload: one fetch for both controls. */
  async function statusPayload() {
    let autostart
    try {
      autostart = await readAutostartState()
    } catch (error) {
      autostart = {
        supported: false,
        enabled: false,
        exePath: null,
        command: null,
        legacy: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    return {
      ok: true,
      plugin: name,
      bootId,
      startedAt,
      restart: restartState(),
      autostart,
    }
  }

  const publish = (path, handler) => {
    const disposer = ctx.webServer.register({ kind: 'exact', path, handler })
    if (typeof ctx.effect === 'function') ctx.effect(() => disposer, `${name}: ${path}`)
  }

  publish(STATUS_ROUTE, async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      respondJson(response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'GET' })
      return
    }
    respondJson(response, 200, await statusPayload())
  })

  publish(RESTART_ROUTE, (request, response) => {
    if (request.method !== 'POST') {
      respondJson(response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
      return
    }
    const refusal = guard(request)
    if (refusal !== null) {
      respondJson(response, refusal.status, { ok: false, error: refusal.error })
      return
    }
    if (restarting) {
      // Not an error the user needs to see: the first click already won.
      respondJson(response, 202, { ok: true, alreadyRestarting: true, bootId })
      return
    }
    if (!verdict.ready) {
      respondJson(response, 409, {
        ok: false,
        error: verdict.detail ?? 'restart is not available here',
        reason: verdict.reason,
      })
      return
    }

    restarting = true
    let helper
    try {
      helper = launchHelper({
        executable: verdict.executable,
        electronPid: verdict.electronPid,
        hostPid: process.pid,
        platform: process.platform,
        handoffDelayMs: numberOr(config.handoffDelayMs, HANDOFF_DELAY_MS),
      })
    } catch (error) {
      restarting = false
      lastError = error instanceof Error ? error.message : String(error)
      console.error('dsh-desktop-tools: starting the restart helper failed', error)
      respondJson(response, 500, { ok: false, error: lastError })
      return
    }

    console.info(`dsh-desktop-tools: restart helper started (pid ${String(helper.pid)}), log at ${helper.logPath}`)
    // 202 first, always: the app is about to be killed and the browser needs the
    // answer before that happens.
    respondJson(response, 202, { ok: true, bootId, helperPid: helper.pid, logPath: helper.logPath })
  })

  publish(AUTOSTART_ROUTE, async (request, response) => {
    if (request.method !== 'POST') {
      respondJson(response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
      return
    }
    const refusal = guard(request)
    if (refusal !== null) {
      respondJson(response, refusal.status, { ok: false, error: refusal.error })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined || typeof body.enabled !== 'boolean') {
      respondJson(response, 400, { ok: false, error: 'invalid-body' })
      return
    }
    const outcome = await writeAutostartState(body.enabled)
    respondJson(response, outcome.ok ? 200 : 500, outcome)
  })
}

/**
 * Spawn the detached helper that performs the restart handoff.
 *
 * @param options - The launch facts, already resolved and validated.
 * @returns the helper's pid and the log it writes.
 */
function launchHelper(options) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const logPath = join(tmpdir(), `dsh-desktop-tools-restart-${stamp}.log`)
  const source = buildHelperSource({ ...options, logPath })

  // The helper runs under the same Electron binary, in Node mode. Keeping
  // ELECTRON_RUN_AS_NODE=1 here is deliberate and is the exact opposite of what
  // the *application* needs: the helper must behave like plain Node, while the
  // app it starts must not (the helper strips the marker itself, see
  // `relaunchEnvironment`).
  const child = spawn(options.executable, ['-e', source], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
  return { pid: child.pid ?? null, logPath }
}

/**
 * The same-origin and same-site gate for the state-changing routes.
 *
 * @param request - the incoming request.
 * @returns `null` to allow, or a status and message to refuse with.
 */
export function guard(request) {
  const headers = request.headers ?? {}
  for (const header of FORWARDING_HEADERS) {
    if (headers[header] !== undefined) {
      return { status: 403, error: 'refused: the request carries a forwarding header' }
    }
  }

  const remote = request.socket?.remoteAddress ?? ''
  if (!isLoopback(remote)) {
    return { status: 403, error: 'refused: the request did not come from the loopback interface' }
  }

  const origin = headers.origin
  const host = headers.host
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    if (typeof host !== 'string' || host === '') {
      return { status: 403, error: 'refused: the request had an Origin but no Host' }
    }
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return { status: 403, error: 'refused: the Origin header was not a URL' }
    }
    if (originHost !== host) {
      return { status: 403, error: 'refused: the request came from another origin' }
    }
  }

  const contentType = headers['content-type']
  if (!/^application\/json\s*(?:;|$)/iu.test(typeof contentType === 'string' ? contentType : '')) {
    return { status: 415, error: 'refused: the request must be application/json' }
  }
  return null
}

/**
 * Whether an address belongs to this machine.
 *
 * The desktop page is served from `dsh-app://app` and reaches the Host over
 * loopback, so accepting the whole 127.0.0.0/8 range and the IPv6 loopback (in
 * a mapped or plain form) is what an honest caller needs and nothing more.
 *
 * @param address - the socket's remote address.
 * @returns whether it is loopback.
 */
export function isLoopback(address) {
  if (typeof address !== 'string' || address === '') return false
  const value = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (value === '::1' || value === 'localhost') return true
  const parts = value.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Read a bounded JSON request body.
 *
 * @param req - the incoming request.
 * @returns the parsed value, or undefined when it is not a JSON object.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function respondJson(response, status, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  })
  response.end(text)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
