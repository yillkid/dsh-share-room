// Server routes against a mock Host: real node:http for guest routes, real
// Fetch Request/Response for owner routes, a scripted typert gateway.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'
import { splitTagged } from '../lib/core.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'))
const EVENTS = fixture.frames.flatMap((f) => f.type === 'snapshot' ? f.records.map((r) => r.event) : f.type === 'event' ? [f.event] : [])
const SRC = 'session-aaaaaaaa-2222-3333-4444-555555555555'
const SID = 'session-11111111-2222-3333-4444-555555555555'

function mockGateway() {
  const sessions = new Map([[SRC, { title: 'Original', events: EVENTS }], [SID, { title: null, events: EVENTS.map((e) => ({ ...e })) }]])
  const followers = new Set()
  const calls = []
  const gw = {
    calls,
    sessions,
    async invoke({ method, args }) {
      const r = args.request ?? args._request
      calls.push({ method, request: r })
      const s = sessions.get(r?.sessionId ?? r?.address?.sessionId)
      if (method === 'projections') return s ? { asOfSeq: s.events.length - 1, values: { title: s.title } } : null
      if (method === 'rename') { s.title = r.title; return { accepted: true } }
      if (method === 'page') return { records: s.events.map((event) => ({ type: 'event', event })), hasMore: false }
      if (method === 'prompt') {
        const seq = s.events.length
        const event = { type: 'user/message', seq, time: Date.now(), data: { content: r.content, source: { kind: 'user', rpcId: 'x' }, role: 'user' } }
        const answer = { type: 'assistant/message', seq: seq + 1, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER' }, { type: 'tool-call', id: 'c', name: 'bash', arguments: '{"command":"cat /secret"}' }] } } }
        s.events.push(event, answer)
        for (const f of followers) if (f.sessionId === r.sessionId) { f.push({ type: 'event', event }); f.push({ type: 'event', event: answer }) }
        return { accepted: true }
      }
      throw Object.assign(new Error(`unexpected ${method}`), { code: 'gateway/input-invalid' })
    },
    async stream({ method, args, signal }) {
      assert.equal(method, 'follow')
      const sessionId = args.request.address.sessionId
      const s = sessions.get(sessionId)
      if (!s) throw Object.assign(new Error('not found'), { code: 'session/not-found' })
      const queue = [{ type: 'snapshot', cursor: s.events.length - 1, records: s.events.map((event) => ({ type: 'event', event })), hasMore: false }]
      let wake
      const f = { sessionId, push: (x) => { queue.push(x); wake?.() } }
      followers.add(f)
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!signal.aborted) {
              if (queue.length) { yield queue.shift(); continue }
              await new Promise((r) => { wake = r; signal.addEventListener('abort', r, { once: true }) })
            }
          } finally { followers.delete(f) }
        },
      }
    },
  }
  return gw
}

async function boot() {
  const routes = new Map()
  let prefix
  const disposers = []
  const gw = mockGateway()
  const ctx = {
    logger: () => ({ warn() {}, error(...a) { console.error(...a) }, info() {} }),
    typertGateway: gw,
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    connection: { fetch: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } } },
    webServer: { register: (r) => { prefix = r; return () => {} } },
  }
  plugin.apply(ctx, { dir: mkdtempSync(join(tmpdir(), 'share-room-srv-')) })
  const server = createServer((req, res) => {
    if (req.url.startsWith('/share/') || req.url === '/share') return prefix.handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const owner = async (path, body) => {
    const route = routes.get(path.split('?')[0])
    const request = new Request(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const res = await route.fetch(request)
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(), res }
  }
  const guest = (path, { body, cookie, origin = base, method } = {}) => fetch(`${base}/share/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { base, gw, routes, owner, guest, close: () => { for (const d of disposers) d(); server.closeAllConnections(); server.close() } }
}

async function readSse(res, until, timeoutMs = 3000) {
  const reader = res.body.getReader()
  const out = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), deadline - Date.now()))])
    if (done || value === undefined) break
    buf += Buffer.from(value).toString('utf8')
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      if (chunk.startsWith('data: ')) out.push(JSON.parse(chunk.slice(6)))
    }
    if (until(out)) break
  }
  reader.cancel().catch(() => {})
  return out
}

async function shareAndJoin(t, opts = {}) {
  const h = await boot()
  t.after(h.close)
  const created = await h.owner('/api/share-room.create', { sessionId: SID, sourceSessionId: SRC, ownerName: 'C', guestName: 'D', ...opts })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const [, shareId, secret] = created.body.invitePath.match(/^\/share\/([^/]+)\/#(.+)$/)
  const joined = await h.guest(`${shareId}/join`, { body: { invite: secret } })
  assert.equal(joined.status, 200)
  const cookie = joined.headers.get('set-cookie').split(';')[0]
  return { ...h, shareId, secret, cookie, setCookie: joined.headers.get('set-cookie') }
}

test('owner routes are registered under /api only', async (t) => {
  const h = await boot(); t.after(h.close)
  for (const path of h.routes.keys()) assert.ok(path.startsWith('/api/'), path)
  assert.ok(h.routes.has('/api/session/prompt'))
})

test('invite: page, confirm, single-use join, scoped HttpOnly cookie', async (t) => {
  const h = await shareAndJoin(t)
  assert.match(h.setCookie, new RegExp(`Path=/share/${h.shareId}/`))
  assert.match(h.setCookie, /HttpOnly/)
  assert.match(h.setCookie, /SameSite=Strict/)
  const page = await h.guest(`${h.shareId}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  assert.ok(!(await page.text()).includes(h.secret))
  const again = await h.guest(`${h.shareId}/join`, { body: { invite: h.secret } })
  assert.equal(again.status, 410)
  assert.equal(h.gw.sessions.get(SID).title, '🔗 Original')
})

test('guest writes need same-origin JSON', async (t) => {
  const h = await shareAndJoin(t)
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'x' }, cookie: h.cookie, origin: 'https://evil.example' })).status, 403)
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'x' }, cookie: h.cookie, origin: null })).status, 403)
  const plain = await fetch(`${h.base}/share/${h.shareId}/say`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie: h.cookie, origin: h.base }, body: '{"text":"x"}' })
  assert.equal(plain.status, 403)
  assert.equal((await h.guest(`${h.shareId}/state`)).status, 401)
  assert.equal((await h.guest(`${h.shareId}/state`, { cookie: `share_room_${h.shareId}=bogus.${'A'.repeat(43)}` })).status, 401)
})

test('guest stream: whitelisted items only, never tool output or prompts', async (t) => {
  const h = await shareAndJoin(t)
  const res = await h.guest(`${h.shareId}/events`, { cookie: h.cookie })
  assert.equal(res.status, 200)
  const frames = await readSse(res, (out) => out.some((f) => f.type === 'reset' && f.items.length > 0))
  const text = JSON.stringify(frames)
  const items = frames.find((f) => f.type === 'reset' && f.items.length).items
  assert.ok(items.some((i) => i.kind === 'answer'))
  for (const needle of ['You are an AI agent', 'contextWindow', '"description":"probe"', 'SECRET_OUTPUT_123\\n', 'sandbox:policy']) assert.ok(!text.includes(needle), needle)
})

test('💬 discuss then 🤖 ask: tagged as the guest, discussion bundled once', async (t) => {
  const h = await shareAndJoin(t, { aiBudget: 1 })
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: '我覺得 A', mode: 'discuss' }, cookie: h.cookie })).status, 200)
  const own = await h.owner('/api/share-room.discuss', { sessionId: SID, text: '我覺得 B' })
  assert.equal(own.status, 200)
  const ask = await h.guest(`${h.shareId}/say`, { body: { text: '哪個好？', mode: 'ai' }, cookie: h.cookie })
  assert.equal(ask.status, 200, await ask.clone().text())
  const prompt = h.gw.calls.filter((c) => c.method === 'prompt').at(-1).request
  assert.equal(prompt.sessionId, SID)
  const split = splitTagged(prompt.content)
  assert.equal(split.speaker.name, 'D')
  assert.equal(split.speaker.role, 'guest')
  assert.deepEqual(split.discussion.map((d) => d.text), ['我覺得 A', '我覺得 B'])
  // Budget: the second question is refused, and it never reaches the session.
  const over = await h.guest(`${h.shareId}/say`, { body: { text: 'again', mode: 'ai' }, cookie: h.cookie })
  assert.equal(over.status, 409)
  assert.equal(h.gw.calls.filter((c) => c.method === 'prompt').length, 1)
  // Owner prompt now carries no discussion (already bundled).
  const envelope = { type: 'client-request', rpcId: 'r1', method: 'session/prompt', payload: { args: { request: { requestId: 'q', sessionId: SID, mode: 'queue', content: [{ type: 'text', text: 'owner asks' }] } } } }
  const routed = await h.routes.get('/api/session/prompt').fetch(new Request(`${h.base}/api/session/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }))
  assert.equal((await routed.json()).result.ok, true)
  const ownerPrompt = splitTagged(h.gw.calls.filter((c) => c.method === 'prompt').at(-1).request.content)
  assert.equal(ownerPrompt.speaker.role, 'owner')
  assert.equal(ownerPrompt.discussion.length, 0)
})

test('owner prompts in unshared sessions pass through untouched', async (t) => {
  const h = await boot(); t.after(h.close)
  const content = [{ type: 'text', text: 'plain' }]
  const envelope = { type: 'client-request', rpcId: 'r', method: 'session/prompt', payload: { args: { request: { requestId: 'q', sessionId: SRC, mode: 'queue', content } } } }
  await h.routes.get('/api/session/prompt').fetch(new Request(`${h.base}/api/session/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }))
  assert.deepEqual(h.gw.calls.filter((c) => c.method === 'prompt').at(-1).request.content, content)
})

test('AI switch off is enforced server-side', async (t) => {
  const h = await shareAndJoin(t)
  const share = (await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.shared
  await h.owner('/api/share-room.settings', { shareId: share.id, aiAllowed: false })
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'q', mode: 'ai' }, cookie: h.cookie })).status, 409)
  assert.equal(h.gw.calls.filter((c) => c.method === 'prompt').length, 0)
})

test('remove guest: stream closes, cookie dead at once', async (t) => {
  const h = await shareAndJoin(t)
  const share = (await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.shared
  const res = await h.guest(`${h.shareId}/events`, { cookie: h.cookie })
  const pending = readSse(res, (out) => out.some((f) => f.type === 'removed'))
  await new Promise((r) => setTimeout(r, 100))
  await h.owner('/api/share-room.remove-guest', { shareId: share.id, guestId: share.guests[0].guestId })
  const frames = await pending
  assert.ok(frames.some((f) => f.type === 'removed'))
  assert.equal((await h.guest(`${h.shareId}/state`, { cookie: h.cookie })).status, 401)
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'x' }, cookie: h.cookie })).status, 401)
})

test('end share: no more writes, read-only view frozen at end time, download works', async (t) => {
  const h = await shareAndJoin(t)
  const share = (await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.shared
  await h.owner('/api/share-room.end', { shareId: share.id })
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'x' }, cookie: h.cookie })).status, 409)
  // Owner keeps working in the session after the end; guests must not see it.
  await new Promise((r) => setTimeout(r, 5))
  const s = h.gw.sessions.get(SID)
  s.events.push({ type: 'assistant/message', seq: s.events.length, time: Date.now() + 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'AFTER_END_PRIVATE' }] } } })
  const state = await (await h.guest(`${h.shareId}/state`, { cookie: h.cookie })).json()
  assert.equal(state.access, 'readonly')
  const md = await (await h.guest(`${h.shareId}/transcript.md`, { cookie: h.cookie })).text()
  assert.match(md, /你好 hello/)
  assert.ok(!md.includes('AFTER_END_PRIVATE'))
  const frames = await readSse(await h.guest(`${h.shareId}/events`, { cookie: h.cookie }), (out) => out.some((f) => f.type === 'reset'))
  assert.ok(!JSON.stringify(frames).includes('AFTER_END_PRIVATE'))
  // Delete read-only page: gone.
  await h.owner('/api/share-room.delete', { shareId: share.id })
  assert.equal((await h.guest(`${h.shareId}/state`, { cookie: h.cookie })).status, 410)
})

test('rejects junk ids and paths', async (t) => {
  const h = await boot(); t.after(h.close)
  assert.equal((await h.guest('..%2F..%2Fetc/')).status, 404)
  assert.equal((await h.guest('_/../../package.json')).status, 404)
  assert.equal((await h.guest('_/app.js')).status, 200)
  const bad = await h.owner('/api/share-room.create', { sessionId: '../x', sourceSessionId: SRC, ownerName: 'C', guestName: 'D' })
  assert.equal(bad.status, 400)
  const same = await h.owner('/api/share-room.create', { sessionId: SRC, sourceSessionId: SRC, ownerName: 'C', guestName: 'D' })
  assert.equal(same.status, 400)
})

test('invite brute force is rate limited, but only failures count', async (t) => {
  const h = await boot(); t.after(h.close)
  const created = await h.owner('/api/share-room.create', { sessionId: SID, sourceSessionId: SRC, ownerName: 'C', guestName: 'D' })
  const [, shareId, secret] = created.body.invitePath.match(/^\/share\/([^/]+)\/#(.+)$/)
  for (let i = 0; i < 30; i++) assert.equal((await h.guest(`${shareId}/invite-info`, { body: { invite: secret } })).status, 200)
  let last
  for (let i = 0; i < 25; i++) last = (await h.guest(`${shareId}/invite-info`, { body: { invite: 'A'.repeat(43) } })).status
  assert.equal(last, 429)
  assert.equal((await h.guest(`${shareId}/join`, { body: { invite: secret } })).status, 429)
})
