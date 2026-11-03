// Locks the Client half's contract.
//
// The client bundle is plain JavaScript loaded by the page's module loader, so
// it cannot be imported here. These assertions read its text instead and pin the
// facts that are easy to break by accident and invisible until a user sees a
// missing button or a page that fails to boot.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CLIENT = readFileSync(join(root, 'client.js'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The bundle without its comments; checks for code must not match prose. */
const CODE = CLIENT.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/[^\n]*$/gmu, '')

test('client half registers the lazy factory the module loader requires', () => {
  assert.match(CLIENT, /window\.__ModuleLoader__\.load\(\{/u)
  // The factory id must equal the package name. The page requests a bundle by
  // PACKAGE name and executes it; if the id it registers is something else, that
  // first execution registers an id nobody asked for, the page then requests the
  // real name as well, and the bundle runs TWICE - which the client-modules host
  // rejects with "duplicate factory registration", taking the whole web boot down.
  assert.match(CLIENT, new RegExp(`id: '${MANIFEST.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`, 'u'))
})

test('client half asks only for modules the manifest injects', () => {
  const requires = [...CODE.matchAll(/require\(\s*'([^']+)'\s*\)/gu)].map((match) => match[1])
  const unique = [...new Set(requires)]
  assert.deepEqual(unique.sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
  for (const name of unique.filter((name) => name.startsWith('@deepseek-ai/'))) {
    assert.ok(MANIFEST.dsh.client.inject.includes(name), `${name} must be injected by the manifest`)
  }
})

test('both features are wired to the same Host routes', () => {
  for (const route of ['/api/dsh-desktop-tools/status', '/api/dsh-desktop-tools/restart', '/api/dsh-desktop-tools/autostart']) {
    assert.ok(CODE.includes(route), route)
  }
  // Restart: the preload's title-bar menu bar.
  assert.match(CODE, /data-windows-menu/u)
  assert.match(CODE, /\[role="menubar"\]/u)
  // Autostart: the additive Settings → General seat.
  assert.match(CODE, /ctx\.slots\.inject\('settings\.general\.item'/u)
  assert.match(CODE, /id: 'dsh-autostart'/u)
  assert.match(CODE, /primitives\.Switch/u)
})

test('the translation is bound through the injected locale service', () => {
  // The earlier local version used ctx.get('locale') during apply; the service
  // was not resolvable then, the dictionary never registered, and the title-bar
  // button rendered as "Restart" in a Chinese UI. Injecting the service is what
  // makes bind() work, so the regression is pinned here.
  assert.match(CODE, /return \{ inject: \['slots', 'locale'\], apply \}/u)
  assert.equal(/ctx\.get\('locale'\)/u.test(CODE), false)
  assert.match(CODE, /ctx\.locale\.register\(NS, 'zh', zh\)/u)
  assert.match(CODE, /ctx\.locale\.register\(NS, 'en', en\)/u)
  assert.match(CODE, /locale\.bind\(NS\)/u)
})

test('both dictionaries carry the same keys', () => {
  const block = (name) => CLIENT.split(`const ${name} = {`)[1].split('\n    }')[0]
  const keys = (name) => [...block(name).matchAll(/'([^']+)':/gu)].map((match) => match[1])
  const zh = keys('zh').sort()
  const en = keys('en').sort()
  assert.ok(zh.length > 0)
  assert.deepEqual(zh, en)
  for (const required of ['restart.label', 'restart.confirm', 'autostart.title', 'autostart.description']) {
    assert.ok(zh.includes(required), required)
  }
})

test('the bundle stays a plain script (no module syntax)', () => {
  assert.equal(/^\s*import\s/mu.test(CODE), false)
  assert.equal(/^\s*export\s/mu.test(CODE), false)
})
