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
const SID2 = 'session-22222222-2222-3333-4444-555555555555'

const projectionsFor = (s) => ({ asOfSeq: s.events.length - 1, values: { title: s.title, permissions: { currentValue: s.permission ?? 'danger-full-access' }, inbox: { 'next-turn': s.inbox ?? [], 'next-step': [] } } })

function mockGateway() {
  const sessions = new Map([[SRC, { title: 'Original', events: EVENTS }], [SID, { title: null, events: EVENTS.map((e) => ({ ...e })) }], [SID2, { title: null, events: EVENTS.map((e) => ({ ...e })) }]])
  const followers = new Set()
  const calls = []
  const gw = {
    calls,
    sessions,
    async invoke({ namespace, method, args }) {
      if (namespace === 'commands') {
        calls.push({ method: `commands/${method}`, request: args })
        assert.equal(method, 'execute')
        const s = sessions.get(args.agentId)
        const m = /^\/permission (\S+)$/.exec(args.line)
        if (!s || !m || gw.refusePermission) return { commandId: 'c', result: { kind: 'error', text: 'no' } }
        s.permission = m[1]
        return { commandId: 'c', result: { kind: 'success', text: `preset ${m[1]}` } }
      }
      const r = args.request ?? args._request
      calls.push({ method, request: r })
      const s = sessions.get(r?.sessionId ?? r?.address?.sessionId)
      if (method === 'projections') {
        if (gw.noProjectionsRpc) throw Object.assign(new Error('no such method'), { code: 'gateway/invocation-unavailable' })
        return s ? projectionsFor(s) : null
      }
      if (method === 'updateQueue') {
        const at = (s.inbox ?? []).findIndex((m) => m.id === r.itemId)
        if (at < 0) throw Object.assign(new Error('gone'), { code: 'session/queue-item-not-found' })
        s.inbox.splice(at, 1)
        return { accepted: true }
      }
      if (method === 'rename') { s.title = r.title; return { accepted: true } }
      if (method === 'page') return { records: s.events.map((event) => ({ type: 'event', event })), hasMore: false }
      if (method === 'prompt') {
        if (s.busy) { (s.inbox ??= []).push({ id: `m-${r.requestId}`, source: { kind: 'user', rpcId: r.requestId }, content: r.content }); return { accepted: true } }
        const seq = s.events.length
        const event = { type: 'user/message', seq, time: Date.now(), data: { content: r.content, source: { kind: 'user', rpcId: 'x' }, role: 'user' } }
        const answer = { type: 'assistant/message', seq: seq + 1, time: Date.now(), data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'ANSWER' }, { type: 'tool-call', id: 'c', name: 'bash', arguments: '{"command":"cat /secret"}' }] } } }
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
      const queue = [{ type: 'snapshot', cursor: s.events.length - 1, records: s.events.map((event) => ({ type: 'event', event })), hasMore: false, projections: projectionsFor(s) }]
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

async function boot({ dir = mkdtempSync(join(tmpdir(), 'share-room-srv-')), config = {} } = {}) {
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
  plugin.apply(ctx, { dir, ...config })
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
  return { base, dir, gw, routes, owner, guest, close: () => { for (const d of disposers) d(); server.closeAllConnections(); server.close() } }
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
  // Wrong guesses stay blocked, and a blocked guess no longer even says whether it was wrong...
  assert.equal((await h.guest(`${shareId}/join`, { body: { invite: 'B'.repeat(43) } })).status, 429)
  // ...but the real invite holder can never be locked out by strangers.
  assert.equal((await h.guest(`${shareId}/join`, { body: { invite: secret } })).status, 200)
})

test('failed invite attempts on one share do not lock out another share', async (t) => {
  const h = await boot(); t.after(h.close)
  const a = await h.owner('/api/share-room.create', { sessionId: SID, sourceSessionId: SRC, ownerName: 'C', guestName: 'D' })
  const [, idA] = a.body.invitePath.match(/^\/share\/([^/]+)\//)
  for (let i = 0; i < 25; i++) await h.guest(`${idA}/invite-info`, { body: { invite: 'A'.repeat(43) } })
  assert.equal((await h.guest(`${idA}/invite-info`, { body: { invite: 'A'.repeat(43) } })).status, 429)
  const b = await h.owner('/api/share-room.create', { sessionId: SID2, sourceSessionId: SRC, ownerName: 'C', guestName: 'E' })
  const [, idB, secretB] = b.body.invitePath.match(/^\/share\/([^/]+)\/#(.+)$/)
  assert.equal((await h.guest(`${idB}/join`, { body: { invite: secretB } })).status, 200)
})

test('ending the share withdraws guest prompts still queued; owner prompts stay', async (t) => {
  const h = await shareAndJoin(t)
  const session = h.gw.sessions.get(SID)
  session.busy = true // a turn is running: new prompts wait in the inbox
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'guest question', mode: 'ai' }, cookie: h.cookie })).status, 200)
  const envelope = { type: 'client-request', rpcId: 'r9', method: 'session/prompt', payload: { args: { request: { requestId: 'owner-q', sessionId: SID, mode: 'queue', content: [{ type: 'text', text: 'owner question' }] } } } }
  await h.routes.get('/api/session/prompt').fetch(new Request(`${h.base}/api/session/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }))
  assert.equal(session.inbox.length, 2)
  const share = (await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.shared
  assert.equal((await h.owner('/api/share-room.end', { shareId: share.id })).status, 200)
  assert.deepEqual(session.inbox.map((m) => m.source.rpcId), ['owner-q'])
})

test('removing a guest withdraws only that guest\'s queued prompts', async (t) => {
  const h = await shareAndJoin(t)
  const session = h.gw.sessions.get(SID)
  session.busy = true
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'q1', mode: 'ai' }, cookie: h.cookie })).status, 200)
  const share = (await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.shared
  await h.owner('/api/share-room.remove-guest', { shareId: share.id, guestId: share.guests[0].guestId })
  assert.equal(session.inbox.length, 0)
})

test('the shared session is made read-only before any invite; guests stop if the owner raises it', async (t) => {
  const h = await shareAndJoin(t)
  assert.equal(h.gw.sessions.get(SID).permission, 'read-only')
  assert.equal(h.gw.sessions.get(SRC).permission, undefined, 'the original session is untouched')
  h.gw.sessions.get(SID).permission = 'danger-full-access'
  const ask = await h.guest(`${h.shareId}/say`, { body: { text: 'q', mode: 'ai' }, cookie: h.cookie })
  assert.equal(ask.status, 409)
  assert.equal(h.gw.calls.filter((c) => c.method === 'prompt').length, 0)
  const state = await (await h.guest(`${h.shareId}/state`, { cookie: h.cookie })).json()
  assert.equal(state.aiLeft, 50, 'refused questions are refunded')
})

test('no read-only session, no share', async (t) => {
  const h = await boot()
  t.after(h.close)
  h.gw.refusePermission = true
  const res = await h.owner('/api/share-room.create', { sessionId: SID, sourceSessionId: SRC, ownerName: 'C', guestName: 'D' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'share-room/permission-unavailable')
  assert.equal((await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.shared, null)
})

test('DSH 0.1.5 (no session/projections RPC): reads projections from the follow snapshot', async (t) => {
  const h = await boot()
  t.after(h.close)
  h.gw.noProjectionsRpc = true
  const created = await h.owner('/api/share-room.create', { sessionId: SID, sourceSessionId: SRC, ownerName: 'C', guestName: 'D' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(h.gw.sessions.get(SID).permission, 'read-only')
  // Probed once, then the fallback is used directly.
  assert.equal(h.gw.calls.filter((c) => c.method === 'projections').length, 1)
  const [, shareId, secret] = created.body.invitePath.match(/^\/share\/([^/]+)\/#(.+)$/)
  const joined = await h.guest(`${shareId}/join`, { body: { invite: secret } })
  const cookie = joined.headers.get('set-cookie').split(';')[0]
  const asked = await h.guest(`${shareId}/say`, { cookie, body: { mode: 'ai', text: 'hi' } })
  assert.equal(asked.status, 200, await asked.clone().text())
  h.gw.sessions.get(SID).permission = 'danger-full-access'
  const refused = await h.guest(`${shareId}/say`, { cookie, body: { mode: 'ai', text: 'again' } })
  assert.equal(refused.status, 409)
  assert.equal(h.gw.calls.filter((c) => c.method === 'prompt').length, 1)
})

test('site switch: on by default; off pauses guests and blocks new shares; back on resumes', async (t) => {
  const h = await shareAndJoin(t)
  assert.deepEqual((await h.owner('/api/share-room.site')).body, { enabled: true })
  assert.equal((await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.enabled, true)

  const off = await h.owner('/api/share-room.site', { enabled: false })
  assert.deepEqual(off.body, { enabled: false })
  // Guests are paused, not removed.
  for (const path of ['state', 'events']) {
    const r = await h.guest(`${h.shareId}/${path}`, { cookie: h.cookie })
    assert.equal(r.status, 403, path)
    assert.equal((await r.json()).error, 'disabled')
  }
  const say = await h.guest(`${h.shareId}/say`, { body: { text: 'q', mode: 'ai' }, cookie: h.cookie })
  assert.equal(say.status, 403)
  assert.equal(h.gw.calls.filter((c) => c.method === 'prompt').length, 0)
  const share = (await h.owner(`/api/share-room.state?sessionId=${SID}`)).body.shared
  // New shares and new invites are refused.
  const invite = await h.owner('/api/share-room.invite', { shareId: share.id, guestName: 'E' })
  assert.equal(invite.status, 400)
  assert.equal(invite.body.error, 'share-room/disabled')
  const created = await h.owner('/api/share-room.create', { sessionId: SID2, sourceSessionId: SRC, ownerName: 'C', guestName: 'F' })
  assert.equal(created.body.error, 'share-room/disabled')
  // Guest page shell and assets still load so guests can see why.
  assert.equal((await h.guest(`${h.shareId}/`)).status, 200)
  assert.equal((await h.guest('_/app.js')).status, 200)

  await h.owner('/api/share-room.site', { enabled: true })
  const back = await h.guest(`${h.shareId}/state`, { cookie: h.cookie })
  assert.equal(back.status, 200)
  assert.equal((await h.guest(`${h.shareId}/say`, { body: { text: 'q', mode: 'ai' }, cookie: h.cookie })).status, 200)
})

test('site switch persists across restarts, validates input, and honours the config default', async (t) => {
  const h = await boot()
  t.after(h.close)
  assert.equal((await h.owner('/api/share-room.site', { enabled: 'no' })).status, 400)
  await h.owner('/api/share-room.site', { enabled: false })
  assert.equal(JSON.parse(readFileSync(join(h.dir, 'settings.json'), 'utf8')).enabled, false)
  const again = await boot({ dir: h.dir })
  t.after(again.close)
  assert.deepEqual((await again.owner('/api/share-room.site')).body, { enabled: false })
  // A site template may default it off; the owner's own choice still wins.
  const offByDefault = await boot({ config: { enabled: false } })
  t.after(offByDefault.close)
  assert.deepEqual((await offByDefault.owner('/api/share-room.site')).body, { enabled: false })
  await offByDefault.owner('/api/share-room.site', { enabled: true })
  assert.deepEqual((await offByDefault.owner('/api/share-room.site')).body, { enabled: true })
})

test('site switch: invite exchange is refused while off and the invite stays usable', async (t) => {
  const h = await boot()
  t.after(h.close)
  const created = await h.owner('/api/share-room.create', { sessionId: SID, sourceSessionId: SRC, ownerName: 'C', guestName: 'D' })
  const [, shareId, secret] = created.body.invitePath.match(/^\/share\/([^/]+)\/#(.+)$/)
  await h.owner('/api/share-room.site', { enabled: false })
  const info = await h.guest(`${shareId}/invite-info`, { body: { invite: secret } })
  assert.equal(info.status, 403)
  assert.equal((await h.guest(`${shareId}/join`, { body: { invite: secret } })).status, 403)
  await h.owner('/api/share-room.site', { enabled: true })
  assert.equal((await h.guest(`${shareId}/join`, { body: { invite: secret } })).status, 200)
})
