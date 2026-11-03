// The detached restart helper.
//
// The Host cannot call `app.relaunch()`: it is a plain Node child process of the
// Electron main process (`ELECTRON_RUN_AS_NODE=1`), not the application itself.
// So the restart is done out-of-process, by a small script that survives the
// death of everything it is replacing:
//
//   1. wait, so the HTTP 202 reaches the browser before the app vanishes;
//   2. kill the Electron main process and this Host, by PID, without `/t`
//      (a taskkill tree would include the helper itself);
//   3. wait until both PIDs are really gone — this is what keeps the relaunch
//      from racing the single-instance lock, which would otherwise demote the
//      new process to a "focus the existing window" no-op;
//   4. start the application again, with the Node-mode marker removed.
//
// The source is built as a string rather than shipped as a file because that
// keeps the helper's exact text reviewable and assertable in tests.

import { DESKTOP_NODE_MARKER } from './target.js'

/** How long the helper waits before killing, so the 202 can flush. */
export const HANDOFF_DELAY_MS = 400

/** How long the helper waits for the old processes to disappear. */
export const EXIT_DEADLINE_MS = 15000

/** How often it re-checks them. */
export const EXIT_POLL_MS = 250

/**
 * Render the helper program.
 *
 * It is plain CommonJS-on-`node -e` source, deliberately dependency-free: it
 * has to run under a bare `node`/Electron binary with no module resolution of
 * ours to rely on.
 *
 * @param options - The launch facts the helper must replay.
 * @returns the JavaScript source to pass to `node -e`.
 */
export function buildHelperSource(options) {
  const payload = {
    executable: String(options.executable ?? ''),
    electronPid: Number(options.electronPid ?? 0),
    hostPid: Number(options.hostPid ?? 0),
    platform: String(options.platform ?? process.platform),
    handoffDelayMs: Number(options.handoffDelayMs ?? HANDOFF_DELAY_MS),
    exitDeadlineMs: Number(options.exitDeadlineMs ?? EXIT_DEADLINE_MS),
    exitPollMs: Number(options.exitPollMs ?? EXIT_POLL_MS),
    strippedEnvKey: DESKTOP_NODE_MARKER,
    logPath: String(options.logPath ?? ''),
  }

  // The config is embedded as a JSON literal, never interpolated as code.
  return `'use strict'
const fs = require('node:fs')
const { spawn, execFile } = require('node:child_process')

const config = ${JSON.stringify(payload, null, 2)}

function log(message) {
  const line = new Date().toISOString() + '  ' + message + '\\n'
  try { fs.appendFileSync(config.logPath, line) } catch {}
  process.stdout.write(line)
}

function alive(pid) {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function killOne(pid) {
  return new Promise((resolve) => {
    if (config.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/f'], { windowsHide: true }, (error) => {
        resolve(error ? 'taskkill: ' + error.message : 'taskkill ok')
      })
      return
    }
    try { process.kill(pid, 'SIGTERM'); resolve('SIGTERM sent') }
    catch (error) { resolve('kill: ' + error.message) }
  })
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitForExit(pids) {
  const deadline = Date.now() + config.exitDeadlineMs
  for (;;) {
    const remaining = pids.filter(alive)
    if (remaining.length === 0) return true
    if (Date.now() > deadline) {
      log('gave up waiting for pids: ' + remaining.join(', '))
      return false
    }
    await delay(config.exitPollMs)
  }
}

function relaunch() {
  const env = { ...process.env }
  delete env[config.strippedEnvKey]
  // The marker is also cleared case-insensitively on Windows, where the
  // environment block is case-insensitive.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === config.strippedEnvKey) delete env[key]
  }
  try {
    const child = spawn(config.executable, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    })
    child.unref()
    log('relaunched ' + config.executable + ' as pid ' + String(child.pid))
    return true
  } catch (error) {
    log('relaunch failed: ' + error.message)
    return false
  }
}

async function main() {
  log('helper started; executable=' + config.executable + ' electronPid=' + config.electronPid + ' hostPid=' + config.hostPid)
  await delay(config.handoffDelayMs)
  for (const pid of [config.electronPid, config.hostPid]) {
    if (pid > 0) log('killing pid ' + pid + ': ' + await killOne(pid))
  }
  const exited = await waitForExit([config.electronPid, config.hostPid])
  log(exited ? 'old processes are gone' : 'proceeding despite surviving processes')
  if (!relaunch()) process.exitCode = 1
}

main().catch((error) => {
  log('helper crashed: ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})
`
}
