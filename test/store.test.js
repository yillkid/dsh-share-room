import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShareStore, guestView, ownerView } from '../lib/store.js'

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
