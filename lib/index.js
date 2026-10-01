// dsh-share-room Host plugin: share ONE DSH session with guests.
//
// Owner side (people who can use this DSH): exact Connection Fetch routes
// under /api/share-room.*, so the stock DSH browser authentication and Origin
// fence apply before any handler runs. The owner's own prompts in a shared
// session are tagged with their name and carry the pending 💬 discussion.
//
// Guest side: a plugin-owned /share/<shareId>/ page. A guest never touches
// /api: their identity is a share-scoped cookie (Path=/share/<shareId>/)
// exchanged once for a single-use invite, checked against the live share on
// every request, so ending a share or removing a guest takes effect at once.
// Guests see only the whitelisted view of that one session (lib/core.js).
//
// Public Host APIs only: connection.fetch.register, webServer.register,
// typertGateway.invoke/stream. No DSH core patch.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cleanName, cleanText, guestCookieName, parseCookies, tagContent, titleFrom, transcriptMarkdown,
  validSecret, validSessionId, validShareId,
} from './core.js'
import { ShareError, ShareStore, guestView, ownerView } from './store.js'
import { SessionTap, itemsFrom, readHistory } from './tap.js'

export const name = 'dsh-share-room'
export const inject = ['connection', 'webServer', 'typertGateway']

const MAX_TEXT = 4000
const MAX_BODY_BYTES = 32 * 1024
const HEARTBEAT_MS = 25_000
const MAX_STREAMS_PER_GUEST = 4
// join counts FAILED invite checks only (brute force); a valid link always works.
const RATE = { say: [20, 60_000], ai: [6, 60_000], join: [20, 600_000] }

const here = dirname(fileURLToPath(import.meta.url))
const ASSETS = {
  'app.js': ['text/javascript; charset=utf-8', join(here, 'guest', 'app.js')],
  'app.css': ['text/css; charset=utf-8', join(here, 'guest', 'app.css')],
}

// ---------------------------------------------------------------------------
// Small HTTP helpers (node:http side, guest routes)

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Same-origin JSON POST: the CSRF fence for every guest write. */
function sameOriginJson(req) {
  if (req.method !== 'POST') return 'method'
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return 'content-type'
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return 'origin'
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return 'origin'
  try { if (new URL(origin).host !== host) return 'origin' } catch { return 'origin' }
  return undefined
}

function secureRequest(req) {
  if (process.env.SHARE_ROOM_SECURE_COOKIE === '1') return true
  if (process.env.SHARE_ROOM_SECURE_COOKIE === '0') return false
  if (req.socket?.encrypted) return true
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
}

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function guestPage(res, shareId) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY',
  })
  res.end(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>分享的對話</title><link rel="stylesheet" href="/share/_/app.css"></head>
<body data-share="${shareId}"><main id="app"><p class="muted">載入中…</p></main><script src="/share/_/app.js"></script></body></html>`)
}

class RateLimiter {
  constructor() { this.hits = new Map() }
  recent(key, windowMs) {
    const now = Date.now()
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs)
    this.hits.set(key, list)
    return list
  }
  /** Over the limit right now? Does not count. */
  blocked(key, [limit, windowMs]) {
    return this.recent(key, windowMs).length >= limit
  }
  /** Count one event. */
  hit(key, [, windowMs]) {
    const now = Date.now()
    this.recent(key, windowMs).push(now)
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= 600_000)) this.hits.delete(k)
  }
  /** Count and report whether this event is still within the limit. */
  allow(key, rate) {
    if (this.blocked(key, rate)) return false
    this.hit(key, rate)
    return true
  }
}

function requestIp(req) {
  return String(req.socket?.remoteAddress ?? 'unknown')
}

function errorBody(error) {
  if (error instanceof ShareError) return { status: 400, body: { error: error.code, message: error.message } }
  return { status: 500, body: { error: 'share-room/internal', message: '伺服器發生錯誤。' } }
}

// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const logger = ctx.logger('share-room')
  const gw = ctx.typertGateway
  const dir = config.dir || process.env.SHARE_ROOM_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'share-room')
  const store = new ShareStore(dir)
  const limiter = new RateLimiter()
  const taps = new Map() // sessionId -> SessionTap
  const guestConns = new Map() // shareId -> Set<{res, guestId}>
  const ownerConns = new Map() // sessionId -> Set<controller>
  const lifetime = new AbortController()

  const invoke = (method, request, signal) => gw.invoke({ namespace: 'session', method, args: { request }, signal: signal ?? lifetime.signal })

  // --- fan-out ----------------------------------------------------------------

  const writeSse = (res, event) => { if (res.writableEnded || res.destroyed) return; try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {} }

  function toGuests(shareId, event, filter = () => true) {
    for (const conn of guestConns.get(shareId) ?? []) if (filter(conn)) writeSse(conn.res, event)
  }

  function toOwners(sessionId, event) {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const controller of ownerConns.get(sessionId) ?? []) { try { controller.enqueue(frame) } catch {} }
  }

  function closeGuests(shareId, filter = () => true) {
    for (const conn of [...(guestConns.get(shareId) ?? [])]) if (filter(conn)) { try { conn.res.end() } catch {} }
  }

  /** Re-send live state to every guest of a share; close streams that lost access. */
  function refreshGuests(share) {
    for (const conn of [...(guestConns.get(share.id) ?? [])]) {
      const guest = share.guests.find((g) => g.guestId === conn.guestId)
      if (!guest || guest.removedAt) { writeSse(conn.res, { type: 'removed' }); try { conn.res.end() } catch {}; continue }
      const view = guestView(store, share, guest)
      writeSse(conn.res, { type: 'state', state: view })
      // Leaving 'active' ends the live stream: the client reconnects and gets
      // the frozen read-only view (or nothing), never later session activity.
      if (view.access !== conn.access) { try { conn.res.end() } catch {} }
    }
    toOwners(share.sessionId, { type: 'share', share: ownerView(store, share) })
  }

  const expiryTimer = setInterval(() => {
    for (const shareId of guestConns.keys()) {
      const share = store.get(shareId)
      if (share) refreshGuests(share)
    }
  }, 60_000)
  expiryTimer.unref?.()

  function tapFor(share) {
    let tap = taps.get(share.sessionId)
    if (tap && !tap.closed) return tap
    tap = new SessionTap({
      gw, sessionId: share.sessionId, logger,
      owner: () => ({ name: share.ownerName }),
      onGone: () => {
        taps.delete(share.sessionId)
        const current = store.get(share.id)
        if (current?.state === 'active') { store.end(share.id, 'session-deleted'); refreshGuests(current) }
      },
    })
    taps.set(share.sessionId, tap)
    return tap
  }

  // --- prompting ----------------------------------------------------------------

  async function ensureTitle(sessionId, title) {
    if (!title) return
    try {
      const p = await invoke('projections', { sessionId })
      if (p && p.values?.title == null) await invoke('rename', { sessionId, title })
    } catch (error) {
      logger.warn('session %s: could not set title: %s', sessionId, error?.message ?? String(error))
    }
  }

  /** Send a tagged prompt for `speaker`, bundling every pending 💬 entry exactly once. */
  async function promptAs(share, speaker, request, signal) {
    return store.exclusive(share.sessionId, async () => {
      // Re-check under the lock: the share may have ended (or the guest been
      // removed) while this request waited behind another prompt.
      if (speaker.role === 'guest') {
        const live = store.get(share.id)
        const guestId = speaker.id.slice('guest:'.length)
        if (store.access(live) !== 'active' || !live.guests.some((g) => g.guestId === guestId && !g.removedAt)) {
          throw new ShareError('share-room/not-active', '分享已結束。')
        }
      }
      const pending = store.pendingDiscussion(share.sessionId)
      const content = tagContent(request.content, speaker, pending)
      await ensureTitle(share.sessionId, titleFrom(request.content))
      const value = await gw.invoke({ namespace: 'session', method: 'prompt', args: { request: { ...request, content } }, signal })
      if (pending.length > 0) {
        const marker = store.markBundled(share.sessionId, pending.at(-1).seq, speaker.id)
        if (marker) {
          toGuests(share.id, { type: 'bundled', upTo: marker.upTo })
          toOwners(share.sessionId, { type: 'bundled', upTo: marker.upTo })
        }
      }
      return value
    })
  }

  function postDiscussion(share, speaker, text) {
    return store.exclusive(share.sessionId, async () => {
      const row = store.appendDiscussion(share.sessionId, speaker, text)
      const { t, ...message } = row
      toGuests(share.id, { type: 'discussion', message })
      toOwners(share.sessionId, { type: 'discussion', message })
      return message
    })
  }

  // ===========================================================================
  // Owner API: /api/share-room.* (stock DSH authentication already applied)

  const ownerRoutes = new Map()
  const ownerRoute = (path, methods, handler) => ownerRoutes.set(path, { methods, handler })

  const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

  async function ownerBody(request) {
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      throw Object.assign(new ShareError('share-room/content-type', 'content type must be application/json'), { status: 415 })
    }
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) throw new ShareError('share-room/too-large', 'request too large')
    try { return JSON.parse(text) } catch { throw new ShareError('share-room/bad-json', 'body is not JSON') }
  }

  const ownerSpeaker = (share) => ({ id: 'owner', name: share.ownerName, role: 'owner' })

  ownerRoute('/api/share-room.state', ['GET'], async (request) => {
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
    if (!validSessionId(sessionId)) return json(400, { error: 'share-room/invalid-session' })
    const { shared, fromHere } = store.forSession(sessionId)
    return json(200, {
      ownerName: store.ownerName() ?? null,
      shared: ownerView(store, shared),
      fromHere: fromHere.filter((s) => store.access(s) === 'active').map((s) => ownerView(store, s)),
      discussion: shared ? store.discussionView(shared.sessionId) : null,
    })
  })

  ownerRoute('/api/share-room.create', ['POST'], async (request) => {
    const body = await ownerBody(request)
    const ownerName = cleanName(body.ownerName) ?? store.ownerName()
    if (!ownerName) throw new ShareError('share-room/invalid-name', '請填你的名字。')
    const guestName = cleanName(body.guestName)
    if (!guestName) throw new ShareError('share-room/invalid-name', '請填訪客的名字（1 到 40 個字）。')
    if (!validSessionId(body.sessionId) || !validSessionId(body.sourceSessionId)) throw new ShareError('share-room/invalid-session', 'invalid session id')
    if (body.sessionId === body.sourceSessionId) throw new ShareError('share-room/invalid-session', '請先 fork 出分享用的對話。')
    const [child, source] = await Promise.all([invoke('projections', { sessionId: body.sessionId }), invoke('projections', { sessionId: body.sourceSessionId })])
    if (!child || !source) throw new ShareError('share-room/invalid-session', '找不到這個對話。')
    if (store.forSession(body.sourceSessionId).shared) throw new ShareError('share-room/already-shared', '這個對話本身就是分享中的對話，請直接邀請新的訪客。')
    if (cleanName(body.ownerName)) store.setOwnerName(ownerName)
    const baseTitle = String(source.values?.title ?? '').trim() || '對話'
    const title = `🔗 ${baseTitle}`.slice(0, 120)
    const share = store.create({
      sessionId: body.sessionId, sourceSessionId: body.sourceSessionId, title: baseTitle, ownerName,
      ttlDays: body.ttlDays, aiAllowed: body.aiAllowed, aiBudget: body.aiBudget, readOnlyDays: body.readOnlyDays,
    })
    try { await invoke('rename', { sessionId: body.sessionId, title }) } catch (error) { logger.warn('rename shared session failed: %s', error?.message) }
    const secret = store.invite(share.id, guestName, { ttlDays: body.ttlDays })
    return json(200, { share: ownerView(store, share), invitePath: `/share/${share.id}/#${secret}` })
  })

  ownerRoute('/api/share-room.invite', ['POST'], async (request) => {
    const body = await ownerBody(request)
    const share = store.mustGet(body.shareId)
    const secret = store.invite(share.id, body.guestName)
    toOwners(share.sessionId, { type: 'share', share: ownerView(store, share) })
    return json(200, { share: ownerView(store, share), invitePath: `/share/${share.id}/#${secret}` })
  })

  ownerRoute('/api/share-room.remove-guest', ['POST'], async (request) => {
    const body = await ownerBody(request)
    const share = store.removeGuest(body.shareId, body.guestId)
    refreshGuests(share) // tells the removed guest, then closes their stream
    return json(200, { share: ownerView(store, share) })
  })

  ownerRoute('/api/share-room.end', ['POST'], async (request) => {
    const body = await ownerBody(request)
    const share = store.end(body.shareId, 'owner')
    refreshGuests(share)
    return json(200, { share: ownerView(store, share) })
  })

  ownerRoute('/api/share-room.delete', ['POST'], async (request) => {
    const body = await ownerBody(request)
    const share = store.deleteReadOnly(body.shareId)
    refreshGuests(share)
    closeGuests(share.id)
    taps.get(share.sessionId)?.close()
    taps.delete(share.sessionId)
    return json(200, { share: ownerView(store, share) })
  })

  ownerRoute('/api/share-room.settings', ['POST'], async (request) => {
    const body = await ownerBody(request)
    const share = store.settings_(body.shareId, { aiAllowed: body.aiAllowed, aiBudget: body.aiBudget })
    refreshGuests(share)
    return json(200, { share: ownerView(store, share) })
  })

  ownerRoute('/api/share-room.owner-name', ['POST'], async (request) => {
    const body = await ownerBody(request)
    return json(200, { ownerName: store.setOwnerName(body.name) })
  })

  ownerRoute('/api/share-room.discuss', ['POST'], async (request) => {
    const body = await ownerBody(request)
    const share = validSessionId(body.sessionId) ? store.activeForSession(body.sessionId) : undefined
    if (!share) throw new ShareError('share-room/not-active', '這個對話目前沒有在分享。')
    const text = cleanText(body.text, MAX_TEXT)
    if (!text) throw new ShareError('share-room/invalid-text', `訊息需要 1 到 ${MAX_TEXT} 個字。`)
    return json(200, { message: await postDiscussion(share, ownerSpeaker(share), text) })
  })

  ownerRoute('/api/share-room.events', ['GET'], async (request) => {
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
    if (!validSessionId(sessionId)) return json(400, { error: 'share-room/invalid-session' })
    let controllerRef
    let heartbeat
    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller
        let set = ownerConns.get(sessionId)
        if (!set) ownerConns.set(sessionId, set = new Set())
        set.add(controller)
        const { shared } = store.forSession(sessionId)
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'snapshot', share: ownerView(store, shared), discussion: shared ? store.discussionView(sessionId) : null })}\n\n`))
        heartbeat = setInterval(() => { try { controller.enqueue(new TextEncoder().encode(': ping\n\n')) } catch {} }, HEARTBEAT_MS)
        const stop = () => cleanup()
        request.signal.addEventListener('abort', stop, { once: true })
        lifetime.signal.addEventListener('abort', stop, { once: true })
      },
      cancel() { cleanup() },
    })
    function cleanup() {
      clearInterval(heartbeat)
      const set = ownerConns.get(sessionId)
      set?.delete(controllerRef)
      if (set?.size === 0) ownerConns.delete(sessionId)
      try { controllerRef?.close() } catch {}
    }
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  })

  // The owner's own prompts: tagged and bundled ONLY inside an active shared
  // session; every other session is forwarded untouched.
  ownerRoute('/api/session/prompt', ['POST'], async (request) => {
    let envelope
    try { envelope = JSON.parse(await request.text()) } catch { return new Response('body is not JSON', { status: 400 }) }
    const args = envelope?.payload?.args
    const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid'
    if (envelope?.type !== 'client-request' || envelope.method !== 'session/prompt' || args === null || typeof args !== 'object') {
      return new Response('invalid client-request envelope', { status: 400 })
    }
    const req = args.request
    const share = validSessionId(req?.sessionId) ? store.activeForSession(req.sessionId) : undefined
    try {
      const value = share && Array.isArray(req.content)
        ? await promptAs(share, ownerSpeaker(share), req, request.signal)
        : await gw.invoke({ namespace: 'session', method: 'prompt', args, signal: request.signal })
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'gateway/internal'
      const details = error?.details !== null && typeof error?.details === 'object' ? error.details : {}
      return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code, message: error?.message ?? String(error), details } } })
    }
  })

  for (const [path, { methods, handler }] of ownerRoutes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods, requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(request)
        } catch (error) {
          if (error?.status === 415) return new Response(error.message, { status: 415 })
          const { status, body } = errorBody(error)
          if (status === 500) logger.error('%s failed: %s', path, error?.stack ?? String(error))
          return json(status, body)
        }
      },
    }), `share-room: ${path}`)
  }

  // ===========================================================================
  // Guest routes: /share/<shareId>/...

  function guestOf(req, shareId) {
    const value = parseCookies(req.headers.cookie).get(guestCookieName(shareId))
    return value === undefined ? undefined : store.guestByCookie(shareId, value)
  }

  async function guestItemsFor(share) {
    if (store.access(share) === 'active') {
      const tap = tapFor(share)
      if (!tap.ready) {
        const off = tap.subscribe(() => {})
        await Promise.race([tap.ready, new Promise((r) => setTimeout(r, 3000))])
        off()
      }
      return tap.snapshot()
    }
    try {
      const p = await invoke('projections', { sessionId: share.sessionId })
      if (!p) return []
      // Frozen at the end of the share: later activity in the session stays private.
      const endedAt = share.state === 'ended' ? share.endedAt : share.expiresAt
      const events = (await readHistory(gw, share.sessionId, p.asOfSeq, lifetime.signal)).filter((e) => !(e.time > endedAt))
      return itemsFrom(events, { name: share.ownerName })
    } catch { return [] }
  }

  async function guestRoute(req, res) {
    const url = new URL(req.url ?? '/', 'http://share.invalid')
    const parts = url.pathname.split('/')
    // ['', 'share', shareId, action?]
    const shareId = parts[2] ?? ''
    const action = parts.slice(3).join('/')

    if (shareId === '_' && parts.length === 4 && Object.hasOwn(ASSETS, action) && (req.method === 'GET' || req.method === 'HEAD')) {
      const [type, file] = ASSETS[action]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
      return res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
    }
    if (!validShareId(shareId)) return sendJson(res, 404, { error: 'not_found' })
    if (parts.length === 3) {
      res.writeHead(308, { location: `/share/${shareId}/`, 'cache-control': 'no-store' })
      return res.end()
    }
    if (action === '' && (req.method === 'GET' || req.method === 'HEAD')) return guestPage(res, shareId)

    // --- invite exchange (no cookie yet) ---
    if (action === 'invite-info' || action === 'join') {
      const bad = sameOriginJson(req)
      if (bad) return sendJson(res, bad === 'method' ? 405 : 403, { error: `invalid_${bad}` })
      // Per share: behind a reverse proxy every guest has the proxy's address, and a
      // site-wide key would let one stranger lock every share. Secrets are 256-bit,
      // so this only bounds noise, not guessing odds.
      const joinKey = `join:${shareId}:${requestIp(req)}`
      if (limiter.blocked(joinKey, RATE.join)) return sendJson(res, 429, { error: 'rate_limited', message: '嘗試次數過多，請稍後再試。' })
      const failed = (status, body) => { limiter.hit(joinKey, RATE.join); return sendJson(res, status, body) }
      let body
      try { body = JSON.parse(await readBody(req)) } catch (error) { return sendJson(res, error?.status ?? 400, { error: 'bad_request' }) }
      const secret = body?.invite
      if (!validSecret(secret)) return failed(400, { error: 'invite_invalid', message: '這個邀請連結不完整。' })
      if (action === 'invite-info') {
        const found = store.peekInvite(shareId, secret)
        if (!found) return failed(410, { error: 'invite_invalid', message: '這個邀請連結無效、已用過或已過期。' })
        return sendJson(res, 200, { title: found.share.title, ownerName: found.share.ownerName, guestName: found.invite.guestName })
      }
      try {
        const { guest, cookieSecret } = store.redeem(shareId, secret)
        const maxAge = Math.max(60, Math.floor((store.get(shareId).expiresAt + store.get(shareId).readOnlyDays * 86_400_000 - Date.now()) / 1000))
        const cookie = `${guestCookieName(shareId)}=${guest.guestId}.${cookieSecret}; Path=/share/${shareId}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureRequest(req) ? '; Secure' : ''}`
        toOwners(store.get(shareId).sessionId, { type: 'share', share: ownerView(store, store.get(shareId)) })
        return sendJson(res, 200, { ok: true }, { 'set-cookie': cookie })
      } catch (error) {
        return failed(410, { error: 'invite_invalid', message: error instanceof ShareError ? error.message : '無法加入。' })
      }
    }

    // --- everything else needs a live guest ---
    const found = guestOf(req, shareId)
    if (!found) {
      const share = store.get(shareId)
      return sendJson(res, 401, { error: 'guest_required', ended: share ? store.access(share) !== 'active' : true })
    }
    const { share, guest } = found
    const access = store.access(share)
    const speaker = { id: `guest:${guest.guestId}`, name: guest.name, role: 'guest' }

    if (action === 'leave') {
      const bad = sameOriginJson(req)
      if (bad) return sendJson(res, 403, { error: `invalid_${bad}` })
      return sendJson(res, 200, { ok: true }, { 'set-cookie': `${guestCookieName(shareId)}=; Path=/share/${shareId}/; HttpOnly; SameSite=Strict; Max-Age=0` })
    }

    if (access === 'gone') return sendJson(res, 410, { error: 'ended', state: guestView(store, share, guest) })

    if (action === 'state' && req.method === 'GET') return sendJson(res, 200, guestView(store, share, guest))

    if (action === 'events' && req.method === 'GET') {
      let set = guestConns.get(shareId)
      if (!set) guestConns.set(shareId, set = new Set())
      // Bounded: a few tabs per guest; the oldest stream of that guest makes room.
      const mine = [...set].filter((c) => c.guestId === guest.guestId)
      if (mine.length >= MAX_STREAMS_PER_GUEST) { try { mine[0].res.end() } catch {}; set.delete(mine[0]) }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' })
      const conn = { res, guestId: guest.guestId, access }
      set.add(conn)
      writeSse(res, { type: 'state', state: guestView(store, share, guest) })
      writeSse(res, { type: 'discussion-reset', ...store.discussionView(share.sessionId) })
      let off = () => {}
      if (access === 'active') {
        off = tapFor(share).subscribe((message) => {
          if (message.type === 'reset') writeSse(res, { type: 'reset', items: message.items })
          else if (message.type === 'items') writeSse(res, { type: 'items', items: message.items })
        })
        const tap = taps.get(share.sessionId)
        if (tap?.items.length) writeSse(res, { type: 'reset', items: tap.snapshot() })
      } else {
        writeSse(res, { type: 'reset', items: await guestItemsFor(share) })
      }
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, HEARTBEAT_MS)
      const close = () => {
        clearInterval(heartbeat)
        off()
        set.delete(conn)
        if (set.size === 0 && guestConns.get(shareId) === set) guestConns.delete(shareId)
      }
      req.on('close', close)
      res.on('close', close)
      return
    }

    if (action === 'transcript.md' && req.method === 'GET') {
      const items = await guestItemsFor(share)
      const md = transcriptMarkdown({ title: share.title, items, discussion: store.discussionView(share.sessionId).messages, endedAt: share.state === 'ended' ? share.endedAt : null })
      const stamp = new Date().toISOString().slice(0, 10)
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="shared-conversation-${stamp}.md"`,
      })
      return res.end(md)
    }

    if (action === 'say') {
      const bad = sameOriginJson(req)
      if (bad) return sendJson(res, bad === 'method' ? 405 : 403, { error: `invalid_${bad}` })
      if (access !== 'active') return sendJson(res, 409, { error: 'ended', message: '分享已結束，不能再發言。' })
      let body
      try { body = JSON.parse(await readBody(req)) } catch (error) { return sendJson(res, error?.status ?? 400, { error: 'bad_request' }) }
      const text = cleanText(body?.text, MAX_TEXT)
      if (!text) return sendJson(res, 400, { error: 'invalid_text', message: `訊息需要 1 到 ${MAX_TEXT} 個字。` })
      if (!limiter.allow(`say:${guest.guestId}`, RATE.say)) return sendJson(res, 429, { error: 'rate_limited', message: '發言太頻繁，請稍等一下。' })
      try {
        if (body.mode === 'ai') {
          if (!limiter.allow(`ai:${guest.guestId}`, RATE.ai)) return sendJson(res, 429, { error: 'rate_limited', message: '問 AI 太頻繁，請稍等一下。' })
          store.chargeAi(share.id, guest.guestId)
          try {
            await promptAs(share, speaker, { requestId: crypto.randomUUID(), sessionId: share.sessionId, mode: 'queue', content: [{ type: 'text', text }] }, lifetime.signal)
          } catch (error) {
            store.refundAi(share.id)
            if (error instanceof ShareError) return sendJson(res, 409, { error: 'ended', message: error.message })
            logger.warn('guest prompt failed for share %s: %s', share.id, error?.code ?? error?.message)
            return sendJson(res, 502, { error: 'ai_failed', message: 'AI 暫時無法接收訊息，請稍後再試。' })
          }
          refreshGuests(share)
          return sendJson(res, 200, { ok: true })
        }
        const message = await postDiscussion(share, speaker, text)
        return sendJson(res, 200, { message })
      } catch (error) {
        const { status, body: out } = errorBody(error)
        return sendJson(res, status === 400 ? 409 : status, out)
      }
    }

    return sendJson(res, 404, { error: 'not_found' })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/share',
    handler: async (req, res) => {
      try {
        await guestRoute(req, res)
      } catch (error) {
        logger.error('guest route failed: %s', error?.stack ?? String(error))
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
        else res.destroy()
      }
    },
  }), 'share-room: /share')

  ctx.effect(() => () => {
    lifetime.abort()
    clearInterval(expiryTimer)
    for (const tap of taps.values()) tap.close()
    taps.clear()
    for (const set of guestConns.values()) for (const conn of set) { try { conn.res.end() } catch {} }
    guestConns.clear()
    for (const set of ownerConns.values()) for (const c of set) { try { c.close() } catch {} }
    ownerConns.clear()
  }, 'share-room: shutdown')
}
