// Upgrade safety: a 0.1.x / 0.2.0 shares.json taken from a live site (anonymized)
// must load in this version unchanged in meaning, and nothing may get WIDER.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShareStore, guestView, ownerView, presetOf } from '../lib/store.js'

const FIXTURE = new URL('./fixtures/shares-v1-live.json', import.meta.url)
const live = JSON.parse(readFileSync(FIXTURE, 'utf8'))

function loadLive(now) {
  const dir = mkdtempSync(join(tmpdir(), 'share-room-compat-'))
  cpSync(FIXTURE, join(dir, 'shares.json'))
  return new ShareStore(dir, { now: () => now })
}

// "Now" = the live data's newest event, so active shares are still active.
const NOW = Math.max(...live.shares.map((s) => s.createdAt)) + 60_000

test('compat: the live file is format v1 and every share loads', () => {
  assert.equal(live.version, 1)
  const store = loadLive(NOW)
  for (const s of live.shares) assert.ok(store.get(s.id), s.id)
})

test('compat: shares without aiPreset (0.1.x) read as read-only, never wider', () => {
  const store = loadLive(NOW)
  const old = live.shares.filter((s) => !('aiPreset' in s))
  assert.ok(old.length > 0, 'fixture has 0.1.x shares')
  for (const s of old) assert.equal(presetOf(store.get(s.id)), 'read-only', s.id)
})

test('compat: active stays active, ended stays ended, guests and AI budget unchanged', () => {
  const store = loadLive(NOW)
  for (const s of live.shares) {
    const got = store.get(s.id)
    const expectActive = s.state === 'active' && NOW < s.expiresAt
    assert.equal(store.access(got) === 'active', expectActive, s.id)
    assert.equal(got.guests.filter((g) => !g.removedAt).length, s.guests.filter((g) => !g.removedAt).length)
    assert.equal(got.aiBudget, s.aiBudget)
    assert.equal(got.aiUsed, s.aiUsed)
  }
})

test('compat: owner and guest views build for every share', () => {
  const store = loadLive(NOW)
  for (const s of live.shares) {
    const share = store.get(s.id)
    assert.ok(ownerView(store, share))
    for (const g of share.guests) assert.equal(guestView(store, share, g).me.name, g.name)
  }
})

test('compat: saving keeps format v1 and loses no share', () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-room-compat-'))
  cpSync(FIXTURE, join(dir, 'shares.json'))
  const store = new ShareStore(dir, { now: () => NOW })
  store.save()
  const after = JSON.parse(readFileSync(join(dir, 'shares.json'), 'utf8'))
  assert.equal(after.version, 1)
  assert.deepEqual(after.shares.map((s) => s.id).sort(), live.shares.map((s) => s.id).sort())
})
