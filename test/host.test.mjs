// Drives the real Host half against a fake Cordis context.
//
// This is the harness that matters: it exercises `apply()` itself - route
// registration, the status payload, the JSON body handling, and every refusal
// path. It never kills anything and never writes the registry: on the machine
// that runs this test the process is plain Node with no app archive beside it, so
// both capabilities report "not ready"/"unsupported", which is exactly what the
// assertions below pin.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, guard, isLoopback } from '../index.js'
import {
  LEGACY_VALUE_NAMES,
  VALUE_NAME,
  desktopExecutable,
  parseRunValues,
  readAutostartState,
  writeAutostartState,
} from '../lib/autostart.js'

/** A minimal stand-in for the Cordis context the plugin is mounted with. */
function fakeContext() {
  const routes = new Map()
  const effects = []
  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    effect(factory, label) {
      const dispose = factory()
      effects.push({ dispose, label })
    },
    mount(config) {
      apply(ctx, config)
      return ctx
    },
    routes,
    disposeAll() {
      for (const { dispose } of effects.reverse()) if (typeof dispose === 'function') dispose()
    },
  }
  return ctx
}

/** A response object that records what the handler wrote. */
function fakeResponse() {
  const record = { status: null, headers: null, body: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(text) {
      record.body = text
    },
  }
}

/**
 * A request with a fixed method/headers and an optional JSON body.
 *
 * @param options - method, headers, body, and the socket remote address.
 * @returns an object the route handlers can consume.
 */
function fakeRequest({ method = 'GET', headers = {}, body = '', remote = '127.0.0.1' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    headers,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:6535' }

test('apply registers the three routes', () => {
  const ctx = fakeContext().mount()
  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/api/dsh-desktop-tools/autostart',
    '/api/dsh-desktop-tools/restart',
    '/api/dsh-desktop-tools/status',
  ])
})

test('status reports a not-ready restart and an unsupported autostart outside the desktop app', async () => {
  const ctx = fakeContext().mount()
  const response = fakeResponse()
  await ctx.routes.get('/api/dsh-desktop-tools/status')(fakeRequest(), response)
  assert.equal(response.record.status, 200)
  const payload = JSON.parse(response.record.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.restart.ready, false)
  assert.equal(payload.restart.reason, 'not-desktop')
  assert.equal(payload.autostart.supported, false)
  assert.equal(payload.autostart.enabled, false)
  assert.equal(typeof payload.bootId, 'string')
})

test('restart refuses any method but POST', async () => {
  const ctx = fakeContext().mount()
  const response = fakeResponse()
  await ctx.routes.get('/api/dsh-desktop-tools/restart')(fakeRequest(), response)
  assert.equal(response.record.status, 405)
})

test('restart refuses a non-JSON request before anything else', async () => {
  const ctx = fakeContext().mount()
  const response = fakeResponse()
  await ctx.routes.get('/api/dsh-desktop-tools/restart')(
    fakeRequest({ method: 'POST', headers: { host: '127.0.0.1:6535' }, body: '{}' }),
    response,
  )
  assert.equal(response.record.status, 415)
})

test('restart refuses a proxied request', async () => {
  const ctx = fakeContext().mount()
  const response = fakeResponse()
  await ctx.routes.get('/api/dsh-desktop-tools/restart')(
    fakeRequest({ method: 'POST', headers: { ...JSON_HEADERS, 'x-forwarded-for': '1.2.3.4' }, body: '{}' }),
    response,
  )
  assert.equal(response.record.status, 403)
})

test('restart is refused, not attempted, when this is not the desktop app', async () => {
  const ctx = fakeContext().mount()
  const response = fakeResponse()
  await ctx.routes.get('/api/dsh-desktop-tools/restart')(
    fakeRequest({ method: 'POST', headers: JSON_HEADERS, body: '{}' }),
    response,
  )
  assert.equal(response.record.status, 409)
  assert.equal(JSON.parse(response.record.body).reason, 'not-desktop')
})

test('autostart rejects a body that is not a boolean switch', async () => {
  const ctx = fakeContext().mount()
  for (const body of ['{}', '{"enabled":1}', 'not-json']) {
    const response = fakeResponse()
    await ctx.routes.get('/api/dsh-desktop-tools/autostart')(
      fakeRequest({ method: 'POST', headers: JSON_HEADERS, body }),
      response,
    )
    assert.equal(response.record.status, 400, body)
  }
})

test('autostart reports failure instead of pretending outside the desktop app', async () => {
  const ctx = fakeContext().mount()
  const response = fakeResponse()
  await ctx.routes.get('/api/dsh-desktop-tools/autostart')(
    fakeRequest({ method: 'POST', headers: JSON_HEADERS, body: '{"enabled":true}' }),
    response,
  )
  assert.equal(response.record.status, 500)
  const payload = JSON.parse(response.record.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.supported, false)
})

test('guard accepts a same-origin loopback request and rejects everything else', () => {
  const request = (overrides = {}) => ({
    headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:6535', ...overrides.headers },
    socket: { remoteAddress: overrides.remote ?? '127.0.0.1' },
  })
  assert.equal(guard(request()), null)
  assert.equal(guard(request({ headers: { origin: 'http://evil.example:6535' } })).status, 403)
  assert.equal(guard(request({ headers: { origin: 'not a url' } })).status, 403)
  assert.equal(guard(request({ headers: { origin: 'http://127.0.0.1:6535', forwarded: 'for=1.2.3.4' } })).status, 403)
  assert.equal(guard(request({ remote: '10.0.0.5' })).status, 403)
  assert.equal(guard(request({ headers: { 'content-type': 'text/plain' } })).status, 415)
})

test('isLoopback accepts loopback in its mapped and plain forms only', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopback(address), true, address)
  }
  for (const address of ['10.0.0.5', '::ffff:10.0.0.5', '', null, undefined]) {
    assert.equal(isLoopback(address), false, String(address))
  }
})

test('desktopExecutable requires a Windows .exe with app.asar beside it', () => {
  const archive = 'C:\\Apps\\app\\resources\\app.asar'
  const exe = 'C:\\Apps\\app\\DeepSeek Harness.exe'
  const exists = (path) => path === archive || path === exe
  assert.equal(desktopExecutable({ platform: 'win32', execPath: exe, exists }), exe)
  assert.equal(desktopExecutable({ platform: 'win32', execPath: 'C:\\node\\node.exe', exists }), undefined)
  assert.equal(desktopExecutable({ platform: 'darwin', execPath: exe, exists }), undefined)
})

test('parseRunValues reads the four-space columns, names with spaces included', () => {
  const stdout = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '    OneDrive    REG_SZ    "C:\\Program Files\\OneDrive\\OneDrive.exe" /background',
    '    ' + VALUE_NAME + '    REG_SZ    "C:\\Apps\\DeepSeek Harness.exe"',
    '',
  ].join('\r\n')
  const values = parseRunValues(stdout)
  assert.equal(values.size, 2)
  assert.equal(values.get(VALUE_NAME).command, '"C:\\Apps\\DeepSeek Harness.exe"')
  assert.equal(values.get('OneDrive').type, 'REG_SZ')
})

test('readAutostartState is disabled when the value is absent and enabled when present', async () => {
  const exe = 'C:\\Apps\\app\\DeepSeek Harness.exe'
  const exists = (path) => path === exe || path === 'C:\\Apps\\app\\resources\\app.asar'
  const options = { platform: 'win32', execPath: exe, exists }

  const missing = await readAutostartState({
    ...options,
    runRegImpl: async () => ({ error: Object.assign(new Error('not found'), { code: 1 }), stdout: '', stderr: '' }),
  })
  assert.equal(missing.supported, true)
  assert.equal(missing.enabled, false)

  const present = await readAutostartState({
    ...options,
    runRegImpl: async () => ({
      error: undefined,
      stdout: `    ${VALUE_NAME}    REG_SZ    "${exe}"`,
      stderr: '',
    }),
  })
  assert.equal(present.enabled, true)
  assert.equal(present.command, `"${exe}"`)
  assert.equal(present.legacy, false)
})

test('a legacy DSH NEXT value reads as enabled and is marked legacy', async () => {
  const exe = 'C:\\Apps\\app\\DeepSeek Harness.exe'
  const exists = () => true
  const legacyName = LEGACY_VALUE_NAMES[0]
  const state = await readAutostartState({
    platform: 'win32',
    execPath: exe,
    exists,
    runRegImpl: async () => ({ error: undefined, stdout: `    ${legacyName}    REG_SZ    "${exe}"`, stderr: '' }),
  })
  assert.equal(state.enabled, true)
  assert.equal(state.legacy, true)
  assert.equal(state.command, `"${exe}"`)
})

test('enabling writes the new value and removes the legacy one', async () => {
  const exe = 'C:\\Apps\\app\\DeepSeek Harness.exe'
  const exists = () => true
  const calls = []
  const result = await writeAutostartState(true, {
    platform: 'win32',
    execPath: exe,
    exists,
    runRegImpl: async (args) => {
      calls.push(args)
      return { error: undefined, stdout: `    ${VALUE_NAME}    REG_SZ    "${exe}"`, stderr: '' }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.enabled, true)
  assert.deepEqual(calls[0], [
    'add',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '/v',
    VALUE_NAME,
    '/t',
    'REG_SZ',
    '/d',
    `"${exe}"`,
    '/f',
  ])
  assert.deepEqual(calls[1], ['delete', calls[0][1], '/v', LEGACY_VALUE_NAMES[0], '/f'])
})

test('disabling tolerates an already missing value', async () => {
  const exe = 'C:\\Apps\\app\\DeepSeek Harness.exe'
  const exists = () => true
  const result = await writeAutostartState(false, {
    platform: 'win32',
    execPath: exe,
    exists,
    runRegImpl: async (args) => {
      if (args[0] === 'delete') {
        return { error: Object.assign(new Error('missing'), { code: 1 }), stdout: '', stderr: '' }
      }
      return { error: undefined, stdout: '', stderr: '' }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.enabled, false)
})
