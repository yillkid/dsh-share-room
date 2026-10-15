// dsh-share-room persistent state under one private directory:
//   shares.json            every share, its guests and invites (hashes only)
//   settings.json          site switches and owner display name
//   discussions/<sid>.jsonl 💬 discussion per shared session
//   audit.jsonl            who did what, never message content
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { cleanName, hashSecret, newId, newSecret, secretMatches, validSessionId, validShareId } from './core.js'

const DAY = 86_400_000

/** DSH permission presets a share may run guest questions under, safest first. */
export const AI_PRESETS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
export const FULL_ACCESS = 'danger-full-access'
/** Shares created before 0.2.0 have no preset field: they were always read-only. */
export const presetOf = (share) => (AI_PRESETS.includes(share?.aiPreset) ? share.aiPreset : 'read-only')

export const LIMITS = Object.freeze({
  maxTtlDays: 90,
  maxReadOnlyDays: 365,
  maxAiBudget: 10_000,
  maxGuests: 20,
  maxInvitesPerShare: 200,
  // Discussion is bounded per shared session: messages and bytes on disk; only
  // the newest messages stay in memory.
  maxDiscussionMessages: 5_000,
  maxDiscussionBytes: 8 * 1024 * 1024,
  discussionInMemory: 1_000,
})

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

function intIn(value, min, max, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export class ShareError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export class ShareStore {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.dir = dir
    this.now = now
    mkdirSync(join(dir, 'discussions'), { recursive: true, mode: 0o700 })
    try { chmodSync(dir, 0o700) } catch {}
    this.file = join(dir, 'shares.json')
    this.shares = new Map()
    if (existsSync(this.file)) {
      const doc = JSON.parse(readFileSync(this.file, 'utf8'))
      if (doc?.version !== 1 || !Array.isArray(doc.shares)) throw new Error('dsh-share-room: unsupported shares.json')
      for (const share of doc.shares) if (validShareId(share?.id)) this.shares.set(share.id, share)
    }
    this.settingsFile = join(dir, 'settings.json')
    this.settings = existsSync(this.settingsFile) ? JSON.parse(readFileSync(this.settingsFile, 'utf8')) : {}
    this.discussions = new Map()
  }

  save() {
    writeAtomic(this.file, `${JSON.stringify({ version: 1, shares: [...this.shares.values()] }, null, 1)}\n`)
  }

  audit(action, fields = {}) {
    appendFileSync(join(this.dir, 'audit.jsonl'), `${JSON.stringify({ at: new Date(this.now()).toISOString(), action, ...fields })}\n`, { mode: 0o600 })
  }

  // --- site switch ----------------------------------------------------------

  /** Whether this site lets anyone share at all. Unset falls back to the given default. */
  enabled(fallback = true) {
    return typeof this.settings.enabled === 'boolean' ? this.settings.enabled : fallback !== false
  }

  setEnabled(on) {
    if (typeof on !== 'boolean') throw new ShareError('share-room/invalid-setting', 'enabled must be true or false')
    this.settings = { ...this.settings, enabled: on }
    writeAtomic(this.settingsFile, `${JSON.stringify(this.settings)}\n`)
    this.audit(on ? 'site.enabled' : 'site.disabled')
    return on
  }

  /** Whether shares on this site may run guest questions with full access. Off unless turned on. */
  fullAccessAllowed(fallback = false) {
    return typeof this.settings.fullAccess === 'boolean' ? this.settings.fullAccess : fallback === true
  }

  setFullAccessAllowed(on) {
    if (typeof on !== 'boolean') throw new ShareError('share-room/invalid-setting', 'fullAccess must be true or false')
    this.settings = { ...this.settings, fullAccess: on }
    writeAtomic(this.settingsFile, `${JSON.stringify(this.settings)}\n`)
    this.audit(on ? 'site.full-access-allowed' : 'site.full-access-disallowed')
    return on
  }

  // --- owner name -----------------------------------------------------------

  ownerName() {
    return cleanName(this.settings.ownerName) ?? undefined
  }

  setOwnerName(name) {
    const clean = cleanName(name)
    if (!clean) throw new ShareError('share-room/invalid-name', '名字需要 1 到 40 個字。')
    this.settings = { ...this.settings, ownerName: clean }
    writeAtomic(this.settingsFile, `${JSON.stringify(this.settings)}\n`)
    return clean
  }

  // --- lifecycle --------------------------------------------------------------

  /**
   * Access level of a share right now:
   *   'active'   guests may read, discuss and (if allowed) ask the AI
   *   'readonly' ended, but guests may still read and download
   *   'gone'     nothing; the page only says the share has ended
   */
  access(share) {
    if (!share) return 'gone'
    const now = this.now()
    if (share.state === 'active' && now < share.expiresAt) return 'active'
    const endedAt = share.state === 'active' ? share.expiresAt : share.endedAt
    if (share.readOnlyDays > 0 && now < endedAt + share.readOnlyDays * DAY && !share.readOnlyDeleted) return 'readonly'
    return 'gone'
  }

  /** Lazily persist time-based expiry so state and audit agree with access(). */
  settle(share) {
    if (share && share.state === 'active' && this.now() >= share.expiresAt) {
      share.state = 'ended'
      share.endedAt = share.expiresAt
      share.endReason = 'expired'
      this.save()
      this.audit('share.expired', { shareId: share.id })
    }
    return share
  }

  get(shareId) {
    return validShareId(shareId) ? this.settle(this.shares.get(shareId)) : undefined
  }

  /** Shares whose shared session is `sessionId` (at most one) or that were made from it. */
  forSession(sessionId) {
    const shared = []
    const fromHere = []
    for (const share of this.shares.values()) {
      this.settle(share)
      if (share.sessionId === sessionId) shared.push(share)
      else if (share.sourceSessionId === sessionId) fromHere.push(share)
    }
    return { shared: shared[0], fromHere }
  }

  activeForSession(sessionId) {
    const { shared } = this.forSession(sessionId)
    return shared && this.access(shared) === 'active' ? shared : undefined
  }

  create({ sessionId, sourceSessionId, title, ownerName, ttlDays, aiAllowed, aiBudget, readOnlyDays }) {
    if (!validSessionId(sessionId)) throw new ShareError('share-room/invalid-session', 'invalid session id')
    if (this.forSession(sessionId).shared) throw new ShareError('share-room/already-shared', '這個對話已經是分享中的對話。')
    const now = this.now()
    const share = {
      id: newId(12),
      sessionId,
      sourceSessionId: validSessionId(sourceSessionId) ? sourceSessionId : null,
      title: String(title ?? '').slice(0, 200) || '分享的對話',
      ownerName: cleanName(ownerName) ?? '擁有者',
      createdAt: now,
      expiresAt: now + intIn(ttlDays, 1, LIMITS.maxTtlDays, 7) * DAY,
      state: 'active',
      endedAt: null,
      endReason: null,
      readOnlyDays: intIn(readOnlyDays, 0, LIMITS.maxReadOnlyDays, 30),
      readOnlyDeleted: false,
      aiAllowed: aiAllowed !== false,
      aiBudget: intIn(aiBudget, 0, LIMITS.maxAiBudget, 50),
      aiUsed: 0,
      aiPreset: 'read-only',
      guests: [],
      invites: [],
    }
    this.shares.set(share.id, share)
    this.save()
    this.audit('share.created', { shareId: share.id, sessionId, sourceSessionId: share.sourceSessionId })
    return share
  }

  /**
   * Issue a single-use invite for `guestName`. Earlier unused invites for the
   * same name are revoked, so "copy a new link" kills the previous one.
   * @returns the bearer secret, shown once and never stored.
   */
  invite(shareId, guestName, { ttlDays = 7 } = {}) {
    const share = this.get(shareId)
    if (!share || this.access(share) !== 'active') throw new ShareError('share-room/not-active', '分享已結束。')
    const name = cleanName(guestName)
    if (!name) throw new ShareError('share-room/invalid-name', '訪客名字需要 1 到 40 個字。')
    if (share.invites.length >= LIMITS.maxInvitesPerShare) throw new ShareError('share-room/too-many-invites', '邀請次數已達上限。')
    const activeGuests = share.guests.filter((g) => !g.removedAt).length
    if (activeGuests >= LIMITS.maxGuests) throw new ShareError('share-room/too-many-guests', '訪客人數已達上限。')
    const now = this.now()
    for (const inv of share.invites) if (inv.guestName === name && !inv.usedAt && !inv.revokedAt) inv.revokedAt = now
    const secret = newSecret()
    share.invites.push({
      id: newId(9),
      inviteHash: hashSecret(secret),
      guestName: name,
      createdAt: now,
      expiresAt: Math.min(now + intIn(ttlDays, 1, LIMITS.maxTtlDays, 7) * DAY, share.expiresAt),
      usedAt: null,
      revokedAt: null,
    })
    this.save()
    this.audit('invite.issued', { shareId, guestName: name })
    return secret
  }

  /** The invite a secret belongs to, if it is still usable. Does not consume it. */
  peekInvite(shareId, secret) {
    const share = this.get(shareId)
    if (!share || this.access(share) !== 'active') return undefined
    const now = this.now()
    const invite = share.invites.find((inv) => secretMatches(secret, inv.inviteHash))
    if (!invite || invite.usedAt || invite.revokedAt || now >= invite.expiresAt) return undefined
    return { share, invite }
  }

  /** Consume an invite: one guest, one cookie secret. */
  redeem(shareId, secret) {
    const found = this.peekInvite(shareId, secret)
    if (!found) throw new ShareError('share-room/invite-invalid', '這個邀請連結無效、已用過或已過期。')
    const { share, invite } = found
    if (share.guests.filter((g) => !g.removedAt).length >= LIMITS.maxGuests) throw new ShareError('share-room/too-many-guests', '訪客人數已達上限。')
    const now = this.now()
    invite.usedAt = now
    const cookieSecret = newSecret()
    const guest = { guestId: newId(9), name: invite.guestName, joinedAt: now, removedAt: null, cookieHash: hashSecret(cookieSecret), inviteId: invite.id }
    share.guests.push(guest)
    this.save()
    this.audit('guest.joined', { shareId, guestId: guest.guestId, guestName: guest.name })
    return { share, guest, cookieSecret }
  }

  /** Resolve a guest cookie value `<guestId>.<secret>`; removed guests never resolve. */
  guestByCookie(shareId, value) {
    const share = this.get(shareId)
    if (!share || typeof value !== 'string') return undefined
    const dot = value.indexOf('.')
    if (dot <= 0) return undefined
    const guestId = value.slice(0, dot)
    const guest = share.guests.find((g) => g.guestId === guestId)
    if (!guest || guest.removedAt || !secretMatches(value.slice(dot + 1), guest.cookieHash)) return undefined
    return { share, guest }
  }

  removeGuest(shareId, guestId, reason = 'owner') {
    const share = this.mustGet(shareId)
    const guest = share.guests.find((g) => g.guestId === guestId)
    if (!guest) throw new ShareError('share-room/not-found', '找不到這位訪客。')
    if (!guest.removedAt) {
      guest.removedAt = this.now()
      for (const inv of share.invites) if (inv.guestName === guest.name && !inv.usedAt && !inv.revokedAt) inv.revokedAt = guest.removedAt
      this.save()
      guest.removedBy = reason
      this.audit(reason === 'left' ? 'guest.left' : 'guest.removed', { shareId, guestId })
    }
    return share
  }

  end(shareId, reason = 'owner') {
    const share = this.mustGet(shareId)
    if (share.state === 'active') {
      share.state = 'ended'
      share.endedAt = this.now()
      share.endReason = reason
      for (const inv of share.invites) if (!inv.usedAt && !inv.revokedAt) inv.revokedAt = share.endedAt
      this.save()
      this.audit('share.ended', { shareId, reason })
    }
    return share
  }

  /** Delete the read-only page and the discussion; the share record stays as a tombstone. */
  deleteReadOnly(shareId) {
    const share = this.mustGet(shareId)
    if (share.state === 'active') this.end(shareId, 'owner')
    share.readOnlyDeleted = true
    this.save()
    rmSync(this.discussionFile(share.sessionId), { force: true })
    this.discussions.delete(share.sessionId)
    this.audit('share.deleted', { shareId })
    return share
  }

  settings_(shareId, { aiAllowed, aiBudget }) {
    const share = this.mustGet(shareId)
    let budget
    if (aiBudget !== undefined) {
      budget = intIn(aiBudget, 0, LIMITS.maxAiBudget, NaN)
      if (Number.isNaN(budget)) throw new ShareError('share-room/invalid-setting', `問 AI 的次數需要是 0 到 ${LIMITS.maxAiBudget} 的整數。`)
      if (budget < share.aiUsed) throw new ShareError('share-room/invalid-setting', `已經問了 ${share.aiUsed} 次，上限不能低於這個數字。`)
    }
    if (typeof aiAllowed === 'boolean') share.aiAllowed = aiAllowed
    if (budget !== undefined) share.aiBudget = budget
    this.save()
    this.audit('share.settings', { shareId, aiAllowed: share.aiAllowed, aiBudget: share.aiBudget })
    return share
  }

  /** Latest expiry a share may have: LIMITS.maxTtlDays after it was created. */
  maxExpiresAt(share) {
    return share.createdAt + LIMITS.maxTtlDays * DAY
  }

  /**
   * Set how many more days a live share stays open, counted from now. Extends
   * or shortens; never past maxExpiresAt, never for a share that has ended.
   */
  setDaysLeft(shareId, days) {
    const share = this.mustGet(shareId)
    if (this.access(share) !== 'active') throw new ShareError('share-room/not-active', '分享已結束，不能再調整天數。')
    const n = typeof days === 'string' && days.trim() !== '' ? Number(days) : days
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxTtlDays) throw new ShareError('share-room/invalid-setting', `天數需要是 1 到 ${LIMITS.maxTtlDays} 的整數。`)
    const now = this.now()
    const wanted = now + n * DAY
    const cap = this.maxExpiresAt(share)
    if (wanted > cap) {
      const most = Math.floor((cap - now) / DAY)
      throw new ShareError('share-room/invalid-setting', most >= 1
        ? `分享最長 ${LIMITS.maxTtlDays} 天（從建立那天算），最多還能設 ${most} 天。`
        : `分享最長 ${LIMITS.maxTtlDays} 天（從建立那天算），已經不能再延長。`)
    }
    const before = share.expiresAt
    share.expiresAt = wanted
    // Unused invites never outlive the share.
    for (const inv of share.invites) if (!inv.usedAt && !inv.revokedAt && inv.expiresAt > wanted) inv.expiresAt = wanted
    this.save()
    this.audit('share.expiry', { shareId, from: new Date(before).toISOString(), to: new Date(wanted).toISOString() })
    return share
  }

  /** Record the permission preset guest questions run under (already applied to the session). */
  setPreset(shareId, preset) {
    const share = this.mustGet(shareId)
    if (!AI_PRESETS.includes(preset)) throw new ShareError('share-room/invalid-setting', 'unknown permission preset')
    const before = presetOf(share)
    share.aiPreset = preset
    this.save()
    if (before !== preset) this.audit('share.permission', { shareId, from: before, to: preset })
    return share
  }

  /** Reserve one guest AI question; throws when not allowed or over budget. */
  chargeAi(shareId, guestId) {
    const share = this.mustGet(shareId)
    if (this.access(share) !== 'active') throw new ShareError('share-room/not-active', '分享已結束。')
    if (!share.aiAllowed) throw new ShareError('share-room/ai-disabled', '擁有者關閉了問 AI。')
    if (share.aiUsed >= share.aiBudget) throw new ShareError('share-room/ai-budget', '問 AI 的次數已用完。')
    share.aiUsed++
    this.save()
    this.audit('ai.asked', { shareId, guestId })
    return share
  }

  refundAi(shareId) {
    const share = this.shares.get(shareId)
    if (share && share.aiUsed > 0) { share.aiUsed--; this.save() }
  }

  mustGet(shareId) {
    const share = this.get(shareId)
    if (!share) throw new ShareError('share-room/not-found', '找不到這個分享。')
    return share
  }

  // --- discussion -------------------------------------------------------------

  discussionFile(sessionId) {
    if (!validSessionId(sessionId)) throw new TypeError('invalid session id')
    return join(this.dir, 'discussions', `${sessionId}.jsonl`)
  }

  discussion(sessionId) {
    const cached = this.discussions.get(sessionId)
    if (cached) return cached
    const state = { messages: [], upTo: 0, seq: 0, count: 0, bytes: 0, lock: Promise.resolve() }
    const file = this.discussionFile(sessionId)
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line === '') continue
        state.bytes += Buffer.byteLength(line, 'utf8') + 1
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (row.t === 'msg' && Number.isInteger(row.seq)) {
          state.messages.push(row)
          state.count++
          state.seq = Math.max(state.seq, row.seq)
          if (state.messages.length > LIMITS.discussionInMemory * 2) state.messages = state.messages.slice(-LIMITS.discussionInMemory)
        }
        if (row.t === 'bundled' && Number.isInteger(row.upTo)) state.upTo = Math.max(state.upTo, row.upTo)
      }
    }
    if (state.messages.length > LIMITS.discussionInMemory) state.messages = state.messages.slice(-LIMITS.discussionInMemory)
    this.discussions.set(sessionId, state)
    return state
  }

  appendDiscussion(sessionId, speaker, text) {
    const state = this.discussion(sessionId)
    const row = { t: 'msg', seq: state.seq + 1, id: speaker.id, name: speaker.name, role: speaker.role, at: new Date(this.now()).toISOString(), text }
    const line = `${JSON.stringify(row)}\n`
    const size = Buffer.byteLength(line, 'utf8')
    if (state.count >= LIMITS.maxDiscussionMessages || state.bytes + size > LIMITS.maxDiscussionBytes) {
      throw new ShareError('share-room/discussion-full', '這個分享的討論已達上限。')
    }
    appendFileSync(this.discussionFile(sessionId), line, { mode: 0o600 })
    state.seq = row.seq
    state.count++
    state.bytes += size
    state.messages.push(row)
    if (state.messages.length > LIMITS.discussionInMemory * 2) state.messages = state.messages.slice(-LIMITS.discussionInMemory)
    return row
  }

  pendingDiscussion(sessionId) {
    const state = this.discussion(sessionId)
    return state.messages.filter((row) => row.seq > state.upTo)
  }

  markBundled(sessionId, upTo, by) {
    const state = this.discussion(sessionId)
    if (upTo <= state.upTo) return undefined
    const row = { t: 'bundled', upTo, by, at: new Date(this.now()).toISOString() }
    const line = `${JSON.stringify(row)}\n`
    appendFileSync(this.discussionFile(sessionId), line, { mode: 0o600 })
    state.bytes += Buffer.byteLength(line, 'utf8')
    state.upTo = upTo
    return row
  }

  discussionView(sessionId) {
    const state = this.discussion(sessionId)
    return { messages: state.messages.slice(-500).map(({ t, ...m }) => m), upTo: state.upTo }
  }

  /** Serialize work per session so one discussion entry rides exactly one prompt. */
  async exclusive(sessionId, task) {
    const state = this.discussion(sessionId)
    const run = state.lock.then(task, task)
    state.lock = run.catch(() => {})
    return run
  }
}

/** Public, credential-free view of a share for the owner UI. */
export function ownerView(store, share) {
  if (!share) return null
  return {
    id: share.id,
    sessionId: share.sessionId,
    sourceSessionId: share.sourceSessionId,
    title: share.title,
    ownerName: share.ownerName,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    state: share.state,
    access: store.access(share),
    endedAt: share.endedAt,
    endReason: share.endReason,
    readOnlyDays: share.readOnlyDays,
    readOnlyDeleted: share.readOnlyDeleted,
    aiAllowed: share.aiAllowed,
    aiBudget: share.aiBudget,
    aiUsed: share.aiUsed,
    aiPreset: presetOf(share),
    maxExpiresAt: store.maxExpiresAt(share),
    guests: share.guests.map((g) => ({ guestId: g.guestId, name: g.name, joinedAt: g.joinedAt, removedAt: g.removedAt })),
    invites: share.invites.filter((i) => !i.usedAt && !i.revokedAt && i.expiresAt > store.now())
      .map((i) => ({ id: i.id, guestName: i.guestName, expiresAt: i.expiresAt })),
  }
}

/** What a guest may know about the share. */
export function guestView(store, share, guest) {
  const access = store.access(share)
  return {
    title: share.title,
    ownerName: share.ownerName,
    me: { name: guest.name },
    access,
    endedAt: share.state === 'ended' ? share.endedAt : (access === 'active' ? null : share.expiresAt),
    expiresAt: share.expiresAt,
    aiAllowed: access === 'active' && share.aiAllowed && share.aiUsed < share.aiBudget,
    aiLeft: Math.max(0, share.aiBudget - share.aiUsed),
  }
}
