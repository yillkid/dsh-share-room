import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShareStore, guestView, ownerView, presetOf } from '../lib/store.js'

const DAY = 86_400_000
const SID = 'session-11111111-2222-3333-4444-555555555555'
const SRC = 'session-aaaaaaaa-2222-3333-4444-555555555555'

function fresh() {
  let now = 1_800_000_000_000
  const dir = mkdtempSync(join(tmpdir(), 'share-room-'))
  const clock = { advance: (ms) => { now += ms } }
  const store = new ShareStore(dir, { now: () => now })
  return { dir, store, clock, reopen: () => new ShareStore(dir, { now: () => now }) }
}

const make = (store, extra = {}) => store.create({ sessionId: SID, sourceSessionId: SRC, title: 'T', ownerName: 'C', ...extra })

test('invite is single use and stored only as a hash', () => {
  const { dir, store } = fresh()
  const share = make(store)
  const secret = store.invite(share.id, 'D')
  assert.ok(!readFileSync(join(dir, 'shares.json'), 'utf8').includes(secret))
  assert.equal((statSync(join(dir, 'shares.json')).mode & 0o777), 0o600)
  assert.ok(store.peekInvite(share.id, secret))
  const { guest, cookieSecret } = store.redeem(share.id, secret)
  assert.equal(guest.name, 'D')
  assert.ok(!readFileSync(join(dir, 'shares.json'), 'utf8').includes(cookieSecret))
  assert.throws(() => store.redeem(share.id, secret), /無效/)
  assert.ok(store.guestByCookie(share.id, `${guest.guestId}.${cookieSecret}`))
  assert.equal(store.guestByCookie(share.id, `${guest.guestId}.${'A'.repeat(43)}`), undefined)
  assert.equal(store.guestByCookie('other', `${guest.guestId}.${cookieSecret}`), undefined)
})

test('reissuing for the same name revokes the old unused link', () => {
  const { store } = fresh()
  const share = make(store)
  const a = store.invite(share.id, 'D')
  const b = store.invite(share.id, 'D')
  assert.equal(store.peekInvite(share.id, a), undefined)
  assert.ok(store.peekInvite(share.id, b))
  assert.equal(ownerView(store, share).invites.length, 1)
})

test('removing a guest kills their cookie immediately; others keep access', () => {
  const { store } = fresh()
  const share = make(store)
  const d = store.redeem(share.id, store.invite(share.id, 'D'))
  const e = store.redeem(share.id, store.invite(share.id, 'E'))
  store.removeGuest(share.id, d.guest.guestId)
  assert.equal(store.guestByCookie(share.id, `${d.guest.guestId}.${d.cookieSecret}`), undefined)
  assert.ok(store.guestByCookie(share.id, `${e.guest.guestId}.${e.cookieSecret}`))
})

test('ending: no writes, invites dead, read-only for readOnlyDays then gone', () => {
  const { store, clock } = fresh()
  const share = make(store, { readOnlyDays: 30 })
  const pending = store.invite(share.id, 'X')
  const d = store.redeem(share.id, store.invite(share.id, 'D'))
  store.end(share.id)
  assert.equal(store.access(share), 'readonly')
  assert.equal(store.peekInvite(share.id, pending), undefined)
  assert.throws(() => store.chargeAi(share.id, d.guest.guestId), /結束/)
  assert.throws(() => store.invite(share.id, 'Y'), /結束/)
  assert.equal(guestView(store, share, d.guest).aiAllowed, false)
  clock.advance(30 * DAY + 1)
  assert.equal(store.access(share), 'gone')
})

test('no read-only page when readOnlyDays is 0; delete removes discussion', () => {
  const { store } = fresh()
  const share = make(store, { readOnlyDays: 0 })
  store.appendDiscussion(SID, { id: 'owner', name: 'C', role: 'owner' }, 'hi')
  store.end(share.id)
  assert.equal(store.access(share), 'gone')
  const s2 = fresh().store
  const sh2 = make(s2)
  s2.appendDiscussion(SID, { id: 'owner', name: 'C', role: 'owner' }, 'hi')
  s2.deleteReadOnly(sh2.id)
  assert.equal(s2.access(sh2), 'gone')
  assert.equal(s2.discussionView(SID).messages.length, 0)
})

test('expiry is lazy but real', () => {
  const { store, clock } = fresh()
  const share = make(store, { ttlDays: 1 })
  const secret = store.invite(share.id, 'D')
  clock.advance(DAY + 1)
  assert.equal(store.peekInvite(share.id, secret), undefined)
  assert.equal(store.get(share.id).state, 'ended')
  assert.equal(store.get(share.id).endReason, 'expired')
})

test('AI budget and switch', () => {
  const { store } = fresh()
  const share = make(store, { aiBudget: 2 })
  store.chargeAi(share.id, 'g')
  store.chargeAi(share.id, 'g')
  assert.throws(() => store.chargeAi(share.id, 'g'), /用完/)
  store.refundAi(share.id)
  store.settings_(share.id, { aiAllowed: false })
  assert.throws(() => store.chargeAi(share.id, 'g'), /關閉/)
  store.settings_(share.id, { aiAllowed: true, aiBudget: 99999999 })
  assert.equal(store.get(share.id).aiBudget, 10000)
})

test('one share per session; state survives reopen', () => {
  const { store, reopen } = fresh()
  const share = make(store)
  assert.throws(() => make(store), /已經/)
  store.appendDiscussion(SID, { id: 'owner', name: 'C', role: 'owner' }, 'one')
  store.appendDiscussion(SID, { id: 'guest:x', name: 'D', role: 'guest' }, 'two')
  store.markBundled(SID, 1, 'owner')
  const again = reopen()
  assert.equal(again.get(share.id).ownerName, 'C')
  assert.deepEqual(again.pendingDiscussion(SID).map((m) => m.text), ['two'])
  assert.equal(again.activeForSession(SID).id, share.id)
})

test('exclusive serializes and survives a failing task', async () => {
  const { store } = fresh()
  const order = []
  const a = store.exclusive(SID, async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); throw new Error('x') })
  const b = store.exclusive(SID, async () => { order.push('b') })
  await assert.rejects(a)
  await b
  assert.deepEqual(order, ['a', 'b'])
})

test('owner view never exposes hashes', () => {
  const { store } = fresh()
  const share = make(store)
  store.redeem(share.id, store.invite(share.id, 'D'))
  store.invite(share.id, 'E')
  const json = JSON.stringify(ownerView(store, share))
  assert.ok(!/Hash/.test(json))
})

test('AI budget can be raised or lowered later, never below what was used', () => {
  const { store } = fresh()
  const share = make(store, { aiBudget: 3 })
  store.chargeAi(share.id, 'g')
  store.chargeAi(share.id, 'g')
  assert.throws(() => store.settings_(share.id, { aiBudget: 1 }), /已經問了 2 次/)
  assert.throws(() => store.settings_(share.id, { aiBudget: 'lots' }), /整數/)
  assert.equal(store.get(share.id).aiBudget, 3, 'a refused change changes nothing')
  store.settings_(share.id, { aiBudget: 2 })
  assert.throws(() => store.chargeAi(share.id, 'g'), /用完/)
  store.settings_(share.id, { aiBudget: 20 })
  store.chargeAi(share.id, 'g')
  assert.equal(store.get(share.id).aiUsed, 3)
})

test('days left: extend or shorten a live share, capped at 90 days from creation', () => {

  const { store, clock } = fresh()
  const share = make(store, { ttlDays: 7 })
  const created = share.createdAt
  store.invite(share.id, 'E', { ttlDays: 7 })
  clock.advance(5 * DAY)
  store.setDaysLeft(share.id, 30)
  assert.equal(store.get(share.id).expiresAt, created + 35 * DAY)
  store.setDaysLeft(share.id, 1)
  assert.equal(store.get(share.id).expiresAt, created + 6 * DAY)
  assert.ok(store.get(share.id).invites.every((i) => i.expiresAt <= created + 6 * DAY), 'unused invites never outlive the share')
  assert.throws(() => store.setDaysLeft(share.id, 86), /最多還能設 85 天/)
  store.setDaysLeft(share.id, 85)
  assert.equal(store.get(share.id).expiresAt, created + 90 * DAY)
  for (const bad of [0, -1, 1.5, 'x', 91]) assert.throws(() => store.setDaysLeft(share.id, bad), /天數|最長/, String(bad))
  clock.advance(85 * DAY)
  assert.equal(store.access(store.get(share.id)), 'readonly')
  assert.throws(() => store.setDaysLeft(share.id, 1), /已結束/, 'only live shares can be extended')
  const ended = make(store, { sessionId: 'session-99999999-2222-3333-4444-555555555555' })
  store.end(ended.id)
  assert.throws(() => store.setDaysLeft(ended.id, 3), /已結束/)
})

test('permission preset: read-only by default and for shares made before 0.2.0; changes are audited', () => {
  const { store, dir, reopen } = fresh()
  const share = make(store)
  assert.equal(presetOf(store.get(share.id)), 'read-only')
  delete store.get(share.id).aiPreset
  assert.equal(presetOf(store.get(share.id)), 'read-only')
  assert.throws(() => store.setPreset(share.id, 'root'), /unknown/)
  store.setPreset(share.id, 'danger-full-access')
  assert.equal(presetOf(reopen().get(share.id)), 'danger-full-access')
  const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
  assert.match(audit, /"action":"share.permission","shareId":"[^"]+","from":"read-only","to":"danger-full-access"/)
})

test('site full-access switch is off unless turned on, and persists', () => {
  const { store, reopen } = fresh()
  assert.equal(store.fullAccessAllowed(), false)
  assert.equal(store.fullAccessAllowed(true), true, 'a site template may default it on')
  assert.throws(() => store.setFullAccessAllowed('yes'), /fullAccess/)
  store.setFullAccessAllowed(true)
  assert.equal(reopen().fullAccessAllowed(), true)
  store.setFullAccessAllowed(false)
  assert.equal(reopen().fullAccessAllowed(true), false, "the owner's choice wins over the default")
})
