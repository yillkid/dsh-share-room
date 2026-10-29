// Load dsh-share-room in a real DSH 0.2 cordis (the one a 0.2 site runs).
//
//   D=$(mktemp -d) && npm install --prefix $D --no-save @deepseek-ai/dsh@0.2.1-rc.5
//   DSH02_PREFIX=$D node --test test/dsh02-load.test.mjs
//
// Skipped without DSH02_PREFIX, so `npm test` stays offline. The Host services the
// plugin uses are stand-ins; what is real is cordis: Context, effect, on (with
// prepend), get, and plugin lifecycle, which is where DSH 0.2 changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const prefix = process.env.DSH02_PREFIX
const skip = prefix ? false : 'DSH02_PREFIX is not set (a directory with @deepseek-ai/dsh@0.2 installed)'

async function loadCordis() {
  const dshPkg = join(prefix, 'node_modules/@deepseek-ai/dsh/package.json')
  const dsh = JSON.parse(readFileSync(dshPkg, 'utf8'))
  const require = createRequire(dshPkg)
  const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  return { version: dsh.version, cordis }
}

function host(Context) {
  const root = new Context()
  const routes = []
  const fetches = []
  root.provide('webServer', {
    register(route) { routes.push(route.path); return () => { routes.splice(routes.indexOf(route.path), 1) } },
  })
  root.provide('connection', {
    fetch: { register(r) { fetches.push(r); return () => { fetches.splice(fetches.indexOf(r), 1) } } },
  })
  root.provide('typertGateway', {
    async invoke() { return null },
    async stream() { return (async function* () {})() },
  })
  root.provide('workspaceRegistry', { archivedSessionIds: [] })
  return { root, routes, fetches }
}

test('DSH02_PREFIX holds DSH 0.2', { skip }, async () => {
  const { version } = await loadCordis()
  assert.match(version, /^0\.2\./)
})

test('dsh-share-room loads in DSH 0.2: routes up, question listener first, clean dispose', { skip }, async () => {
  const { cordis } = await loadCordis()
  const mod = await import(pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname).href)
  const { root, routes, fetches } = host(cordis.Context)
  const home = mkdtempSync(join(tmpdir(), 'dsr-dsh02-'))
  process.env.DSH_HOME = home

  // DSH's own Web answerer registers before share-room and would hold next() until the owner answers.
  const order = []
  root.on('user-questions/request', (_request, next) => { order.push('dsh-answerer'); return next() })

  const fiber = root.plugin({ name: 'dsh-share-room', inject: mod.inject, apply: mod.apply }, {})
  await fiber.await() // rethrows a startup error
  assert.equal(fiber.state, 2 /* FiberState.ACTIVE */)
  assert.ok(routes.some((p) => p.startsWith('/share')), 'guest routes registered: ' + routes.join(','))
  assert.ok(fetches.length >= 1, 'owner api registered')

  // Real 0.2 waterfall, dispatched the way dsh-user-questions does. The inner `next` stands for
  // "nobody else answered". share-room passes on a session that is not shared; what matters is
  // ORDER: in a Cordis waterfall the first listener owns next(), so share-room must run before
  // DSH's answerer, or it never sees a question while the owner's page is open.
  const request = { agent: { id: 'session-00000000-0000-0000-0000-000000000000' },
    questions: [{ id: 'q1', question: '?', options: [{ label: 'A' }] }] }
  const hooks = root.events._hooks['user-questions/request']
  const shareRoomFirst = hooks[0]?.ctx !== root
  assert.ok(shareRoomFirst, 'share-room (prepend) is first in the 0.2 waterfall, ahead of a listener registered earlier')
  const answer = await root.waterfall('user-questions/request', request, () => { order.push('inner'); return { answers: { q1: 'A' } } })
  assert.deepEqual(answer, { answers: { q1: 'A' } })
  assert.deepEqual(order, ['dsh-answerer', 'inner'], 'not shared: share-room passed through to the rest of the chain')

  await fiber.dispose()
  assert.deepEqual(routes, [])
  assert.equal(fetches.length, 0)
})
