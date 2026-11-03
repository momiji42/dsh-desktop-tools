// Target discovery for the desktop restart: is this Host running under the
// packaged Electron desktop app, and what executable would relaunch it?
//
// Every decision here is a pure function of its inputs so it can be tested
// without a desktop around it. Nothing in this file touches the process, the
// filesystem, or the network by itself.

import { dirname, join } from 'node:path'

/**
 * The marker the desktop shell sets on the Host child it spawns.
 * `DesktopHostProcess.start()` adds `ELECTRON_RUN_AS_NODE: "1"` through
 * `desktopNodeEnvironment`, and that variable is inherited by every plugin.
 */
export const DESKTOP_NODE_MARKER = 'ELECTRON_RUN_AS_NODE'

/** Where the packaged app keeps its asar archive, relative to the executable. */
export const ASAR_RELATIVE_PATH = ['resources', 'app.asar']

/** The node-module names that must NOT leak into a fresh app launch. */
const STRIPPED_ENV_KEYS = [DESKTOP_NODE_MARKER, 'DSH_DESKTOP_NODE_EXECUTABLE']

/**
 * Decide whether a given process looks like a desktop Host, without asserting
 * anything about a machine this test does not run on.
 *
 * The check is deliberately two-part. `ELECTRON_RUN_AS_NODE` alone is also set
 * for any Electron binary run in Node mode (including a packaged CLI), so the
 * archive next to the executable is what actually distinguishes the desktop app.
 *
 * @param options.env - The environment of the process being judged.
 * @param options.execPath - Its `process.execPath`.
 * @param options.exists - A file-existence predicate (`existsSync`), injected.
 * @returns whether this is the desktop app, why not when it is not, and the
 *   executable a relaunch would use.
 */
export function inspectDesktopTarget({ env = {}, execPath = '', exists = () => false } = {}) {
  const marker = env[DESKTOP_NODE_MARKER]
  if (marker !== '1') {
    return {
      desktop: false,
      reason: 'not-desktop',
      detail: `this Host was not started by the desktop shell (${DESKTOP_NODE_MARKER}=${JSON.stringify(marker ?? null)})`,
      executable: null,
      electronPid: null,
    }
  }

  // `process.execPath` inside the Host is the Electron executable, because that
  // is what the shell spawned. The shell also publishes the same path as
  // DSH_DESKTOP_NODE_EXECUTABLE; use it only as a fallback, so a stale variable
  // from an outer environment cannot override the process we are actually in.
  const candidates = [execPath, env.DSH_DESKTOP_NODE_EXECUTABLE].filter(
    (value) => typeof value === 'string' && value !== '',
  )

  for (const candidate of candidates) {
    if (exists(join(dirname(candidate), ...ASAR_RELATIVE_PATH))) {
      return { desktop: true, reason: 'desktop', detail: null, executable: candidate, electronPid: null }
    }
  }

  return {
    desktop: false,
    reason: 'no-app-archive',
    detail: candidates.length === 0
      ? 'no executable path was available to locate the app archive'
      : `no ${ASAR_RELATIVE_PATH.join('/')} beside ${candidates.join(' or ')}`,
    executable: null,
    electronPid: null,
  }
}

/**
 * Build the environment a *replacement app* must be launched with.
 *
 * This is the single most fragile step of the whole restart. The restart helper
 * itself runs with `ELECTRON_RUN_AS_NODE=1` (that is how the Electron binary
 * behaves like plain Node), and if that variable reached the relaunch the new
 * instance would start as a headless Node script instead of the application.
 *
 * @param env - The environment to clean (normally the Host's own).
 * @returns A copy without the desktop Node-mode markers.
 */
export function relaunchEnvironment(env = {}) {
  const next = { ...env }
  for (const key of STRIPPED_ENV_KEYS) delete next[key]
  return next
}

/**
 * Whether a platform can be restarted with the mechanisms this plugin uses.
 * Windows is what the manifest describes and what has been verified; the others
 * share the same POSIX signal path and are allowed but reported as unverified.
 */
export function restartSupport(platform = process.platform) {
  if (platform === 'win32') return { supported: true, mode: 'taskkill', verified: true }
  if (platform === 'darwin' || platform === 'linux') return { supported: true, mode: 'signal', verified: false }
  return { supported: false, mode: null, verified: false }
}

/**
 * The complete readiness verdict the Host publishes on its status route and the
 * Client renders as either an enabled button or a disabled one with a reason.
 *
 * @param options.target - A result from {@link inspectDesktopTarget}.
 * @param options.platform - The platform to judge support for.
 * @param options.hostPid - This Host process's pid.
 * @param options.parentPid - Its parent, the Electron main process.
 * @returns the verdict, with a human-readable reason whenever it is not ready.
 */
export function readiness({ target, platform = process.platform, hostPid = null, parentPid = null } = {}) {
  if (target === undefined || target === null || target.desktop !== true) {
    return {
      ready: false,
      reason: 'not-desktop',
      detail: target?.detail ?? 'this is not the desktop application',
      executable: null,
      hostPid,
      electronPid: null,
    }
  }
  const support = restartSupport(platform)
  if (!support.supported) {
    return {
      ready: false,
      reason: 'unsupported-platform',
      detail: `restarting is not supported on ${platform}`,
      executable: target.executable,
      hostPid,
      electronPid: parentPid,
    }
  }
  if (typeof parentPid !== 'number' || parentPid <= 0) {
    return {
      ready: false,
      reason: 'no-parent',
      detail: 'the desktop shell process could not be identified',
      executable: target.executable,
      hostPid,
      electronPid: null,
    }
  }
  return {
    ready: true,
    reason: 'ready',
    detail: null,
    executable: target.executable,
    hostPid,
    electronPid: parentPid,
    mode: support.mode,
    verified: support.verified,
  }
}
