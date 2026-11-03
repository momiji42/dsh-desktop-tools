// The Windows sign-in autostart entry.
//
// The desktop build has no built-in "start with Windows" preference, so this
// module owns exactly one thing: the per-user `Run` registry value that points at
// the running application's executable. It never touches HKCU at large, never
// touches a machine-wide key, and never needs elevation - the Run key is the
// documented per-user place for exactly this.
//
// Two details are deliberate:
//
//   * The executable is `process.execPath` of the Host, which under the desktop
//     shell is the app's own `.exe`. It is only trusted when an `app.asar` sits
//     beside it, so a plain `dsh web` (whose `execPath` is `node.exe`) cannot
//     write `node.exe` into the Run key as if it were the app.
//   * This plugin once shipped under a different name and wrote a `DSH NEXT`
//     value. That legacy value is still recognised (so the switch shows the
//     truth on an upgraded machine) and is migrated by the write path instead of
//     being left behind as a second, invisible startup entry.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The per-user Run key; the only registry key this plugin writes. */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** The value name this plugin owns. */
export const VALUE_NAME = 'DeepSeek Harness'

/** Names earlier versions of this plugin used; read for state, removed on write. */
export const LEGACY_VALUE_NAMES = ['DSH NEXT']

/** Marker that proves the executable is the packaged desktop app. */
const APP_ARCHIVE = ['resources', 'app.asar']

const REG_TIMEOUT_MS = 15000

/**
 * Run `reg.exe` without a shell and collect its outcome.
 *
 * @param args - exact argv elements passed to reg.exe.
 * @returns the exit error, stdout, and stderr.
 */
export function runReg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: REG_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/**
 * Parse the block `reg query <key>` prints.
 *
 * The format is four-space separated columns:
 *
 *     ValueName    REG_SZ    "C:\path\to\app.exe"
 *
 * Value names may themselves contain spaces, so the name is the non-greedy run
 * before the first four-space column gap.
 *
 * @param stdout - the command's standard output.
 * @returns value name to its type and command line.
 */
export function parseRunValues(stdout) {
  const values = new Map()
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s+(.+?)\s{4,}(REG_[A-Z_]+)\s{4,}(.*)$/u.exec(line)
    if (match === null) continue
    const [, name, type, data] = match
    values.set(name.trim(), { type, command: data.trim() })
  }
  return values
}

/**
 * The Desktop executable a login entry should launch.
 *
 * @param options.platform - the platform to judge.
 * @param options.execPath - this Host process's executable.
 * @param options.exists - a file-existence predicate, injected for tests.
 * @returns the absolute executable path, or undefined outside a Windows Desktop build.
 */
export function desktopExecutable({
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32') return undefined
  if (typeof execPath !== 'string' || !/\.exe$/iu.test(execPath)) return undefined
  if (!exists(join(dirname(execPath), ...APP_ARCHIVE))) return undefined
  return exists(execPath) ? execPath : undefined
}

/**
 * Current autostart state, derived from the registry rather than cached.
 *
 * @param options - injectable platform facts and `reg.exe` runner, for tests.
 * @returns capability, whether an entry exists, and the command line it names.
 */
export async function readAutostartState({
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync,
  runRegImpl = runReg,
} = {}) {
  const exePath = desktopExecutable({ platform, execPath, exists })
  if (exePath === undefined) {
    return { supported: false, enabled: false, exePath: null, command: null, legacy: false }
  }

  const result = await runRegImpl(['query', RUN_KEY])
  if (result.error) {
    // A missing key (exit code 1) is the normal "nothing starts" answer.
    if (result.error.code === 1) {
      return { supported: true, enabled: false, exePath, command: null, legacy: false }
    }
    const detail = result.stderr.trim() || result.error.message
    return { supported: true, enabled: false, exePath, command: null, legacy: false, error: `读取启动项失败：${detail}` }
  }

  const values = parseRunValues(result.stdout)
  const primary = values.get(VALUE_NAME)
  const legacyName = LEGACY_VALUE_NAMES.find((name) => values.has(name))
  const command = primary?.command || (legacyName === undefined ? '' : values.get(legacyName).command) || null
  return {
    supported: true,
    enabled: command !== null,
    exePath,
    command,
    legacy: primary === undefined && legacyName !== undefined,
  }
}

/**
 * Create or remove the per-user login entry for the current executable.
 *
 * @param enabled - true to write the Run value, false to delete it.
 * @param options - injectable platform facts and `reg.exe` runner, for tests.
 * @returns `{ ok: true, ...state }` or `{ ok: false, error }`.
 */
export async function writeAutostartState(enabled, {
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync,
  runRegImpl = runReg,
} = {}) {
  const exePath = desktopExecutable({ platform, execPath, exists })
  if (exePath === undefined) {
    return { ok: false, supported: false, error: 'unsupported' }
  }

  if (enabled) {
    const add = await runRegImpl([
      'add',
      RUN_KEY,
      '/v',
      VALUE_NAME,
      '/t',
      'REG_SZ',
      '/d',
      `"${exePath}"`,
      '/f',
    ])
    if (add.error) {
      const detail = add.stderr.trim() || add.error.message
      return { ok: false, supported: true, error: `写入启动项失败：${detail}` }
    }
    // Migrate: the new value exists, so the old name must not survive beside it.
    for (const legacy of LEGACY_VALUE_NAMES) {
      await runRegImpl(['delete', RUN_KEY, '/v', legacy, '/f'])
    }
  } else {
    for (const name of [VALUE_NAME, ...LEGACY_VALUE_NAMES]) {
      const result = await runRegImpl(['delete', RUN_KEY, '/v', name, '/f'])
      // Deleting a value that is already gone means the requested state holds.
      if (result.error && result.error.code !== 1) {
        const detail = result.stderr.trim() || result.error.message
        return { ok: false, supported: true, error: `删除启动项失败：${detail}` }
      }
    }
  }

  const state = await readAutostartState({ platform, execPath, exists, runRegImpl })
  return { ok: true, ...state }
}
