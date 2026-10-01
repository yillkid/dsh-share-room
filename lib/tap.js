// SessionTap: one upstream session/follow per shared session, mapped through
// the guest whitelist and fanned out to every guest connection.
import { guestItems } from './core.js'

const PAGE_MESSAGES = 200
const MAX_PAGES = 50
const MAX_ITEMS = 5000

function eventOf(record) {
  if (record?.type === 'event' && record.event) return record.event
  if (record && typeof record.type === 'string' && Number.isInteger(record.seq)) return record
  return undefined
}

/**
 * Read a session's history oldest-first through `session/page`, newest pages
 * first. Bounded: at most MAX_PAGES pages of PAGE_MESSAGES messages.
 */
export async function readHistory(gw, sessionId, throughSeq, signal) {
  const pages = []
  let beforeSeq
  for (let i = 0; i < MAX_PAGES; i++) {
    const request = { address: { kind: 'session', sessionId }, throughSeq, maxMessages: PAGE_MESSAGES, ...(beforeSeq === undefined ? {} : { beforeSeq }) }
    const page = await gw.invoke({ namespace: 'session', method: 'page', args: { request }, signal })
    const events = (page?.records ?? []).map(eventOf).filter(Boolean)
    pages.unshift(events)
    if (!page?.hasMore || events.length === 0) break
    beforeSeq = events[0].seq
  }
  return pages.flat()
}

/**
 * Current projection values of a session: `{ asOfSeq, values }`.
 * DSH 0.1.7 has a `session/projections` RPC; 0.1.5 does not, but every
 * `session/follow` stream opens with the same baseline, so read that and stop.
 */
const projectionsRpc = new WeakMap() // gateway -> Promise<boolean>: does session/projections exist?
export async function projectionsOf(gw, sessionId, signal) {
  const request = { sessionId }
  const call = () => gw.invoke({ namespace: 'session', method: 'projections', args: { request }, signal })
  let known = projectionsRpc.get(gw)
  if (known === undefined) {
    // First caller probes; concurrent callers wait for its answer.
    const probe = call().then((value) => ({ value }), (error) => ({ error }))
    projectionsRpc.set(gw, known = probe.then((r) => !(r.error && isMissingMethod(r.error))))
    const r = await probe
    if (!r.error) return r.value
    if (!isMissingMethod(r.error)) { projectionsRpc.delete(gw); throw r.error }
  } else if (await known) {
    return call()
  }
  const abort = new AbortController()
  const stop = () => abort.abort()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const stream = await gw.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } }, signal: abort.signal })
    for await (const frame of stream) {
      if (frame?.type === 'snapshot') return frame.projections
    }
    throw Object.assign(new Error('follow ended without a snapshot'), { code: 'share-room/no-snapshot' })
  } finally {
    signal?.removeEventListener('abort', stop)
    abort.abort()
  }
}

function isMissingMethod(error) {
  // 0.1.5 reports a method nobody exports as invocation-unavailable.
  return ['gateway/method-unavailable', 'gateway/definition-unavailable', 'gateway/invocation-unavailable'].includes(error?.code)
}

export function itemsFrom(events, owner) {
  const out = []
  for (const event of events) out.push(...guestItems(event, owner))
  return out.slice(-MAX_ITEMS)
}

export class SessionTap {
  /**
   * @param opts.gw - typertGateway
   * @param opts.sessionId - the shared session
   * @param opts.owner - () => {name}
   * @param opts.onGone - called once when the session no longer exists
   * @param opts.logger - Cordis logger
   */
  constructor({ gw, sessionId, owner, onGone, logger }) {
    Object.assign(this, { gw, sessionId, owner, onGone, logger })
    this.items = []
    this.seen = new Set()
    this.listeners = new Set()
    this.abort = undefined
    this.ready = undefined
    this.closed = false
    this.idleTimer = undefined
  }

  subscribe(listener) {
    clearTimeout(this.idleTimer)
    this.listeners.add(listener)
    if (!this.ready) this.ready = this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.idleTimer = setTimeout(() => { if (this.listeners.size === 0) this.close() }, 30_000)
    }
  }

  emit(message) {
    for (const fn of [...this.listeners]) {
      try { fn(message) } catch {}
    }
  }

  push(events) {
    const fresh = []
    for (const event of events) {
      if (this.seen.has(event.seq)) continue
      this.seen.add(event.seq)
      fresh.push(...guestItems(event, this.owner()))
    }
    if (fresh.length === 0) return
    this.items.push(...fresh)
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS)
    this.emit({ type: 'items', items: fresh })
  }

  async start() {
    let delay = 1000
    let first = true
    while (!this.closed) {
      const abort = new AbortController()
      this.abort = abort
      try {
        const stream = await this.gw.stream({
          namespace: 'session', method: 'follow',
          args: { request: { address: { kind: 'session', sessionId: this.sessionId }, maxMessages: PAGE_MESSAGES } },
          signal: abort.signal,
        })
        for await (const frame of stream) {
          if (this.closed) break
          if (frame?.type === 'snapshot') {
            let events = (frame.records ?? []).map(eventOf).filter(Boolean)
            if (frame.hasMore && events.length > 0) {
              const older = await readHistory(this.gw, this.sessionId, events[0].seq - 1 >= 0 ? events[0].seq - 1 : 0, abort.signal).catch(() => [])
              events = [...older.filter((e) => e.seq < events[0].seq), ...events]
            }
            this.items = []
            this.seen = new Set()
            const items = []
            for (const event of events) { this.seen.add(event.seq); items.push(...guestItems(event, this.owner())) }
            this.items = items.slice(-MAX_ITEMS)
            this.emit({ type: 'reset', items: this.items })
            first = false
            delay = 1000
          } else if (frame?.type === 'event' && frame.event) {
            this.push([frame.event])
          }
        }
        if (this.closed) return
      } catch (error) {
        if (this.closed) return
        const code = error?.code
        if (code === 'session/not-found') {
          this.logger?.warn('shared session %s is gone; ending its share', this.sessionId)
          this.close()
          this.onGone?.()
          return
        }
        this.logger?.warn('follow %s failed (%s); retrying', this.sessionId, code ?? error?.message ?? String(error))
      }
      if (first) this.emit({ type: 'reset', items: this.items })
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 30_000)
    }
  }

  snapshot() {
    return this.items
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idleTimer)
    this.abort?.abort()
    this.emit({ type: 'closed' })
    this.listeners.clear()
  }
}
