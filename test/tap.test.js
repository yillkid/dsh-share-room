// projectionsOf across DSH versions: the session/projections RPC (0.1.7, 0.2) and the
// follow-snapshot fallback (0.1.5, and 0.2 sessions that still need migration).
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectionsOf } from '../lib/tap.js'

const SNAPSHOT = { asOfSeq: 42, values: { title: '對話' } }

function gateway(projections) {
  const calls = []
  return {
    calls,
    async invoke({ namespace, method }) {
      calls.push(`${namespace}/${method}`)
      if (typeof projections === 'function') return projections()
      return projections
    },
    async stream({ namespace, method }) {
      calls.push(`${namespace}/${method}`)
      return (async function* () { yield { type: 'snapshot', projections: SNAPSHOT } })()
    },
  }
}

test('0.1.7: projections RPC value is used as is', async () => {
  const gw = gateway({ asOfSeq: 7, values: { title: 'x' } })
  assert.deepEqual(await projectionsOf(gw, 's1'), { asOfSeq: 7, values: { title: 'x' } })
  assert.deepEqual(gw.calls, ['session/projections'])
})

test('0.2 sequenced: used as is (asOfSeq present)', async () => {
  const gw = gateway({ kind: 'sequenced', asOfSeq: 9, values: { title: 'y' } })
  const p = await projectionsOf(gw, 's1')
  assert.equal(p.asOfSeq, 9)
  assert.deepEqual(gw.calls, ['session/projections'])
})

test('0.2 migration-required: no asOfSeq, so the follow snapshot is used (first and later calls)', async () => {
  const gw = gateway({ kind: 'migration-required', values: { title: 'cached' } })
  assert.deepEqual(await projectionsOf(gw, 's1'), SNAPSHOT)
  assert.deepEqual(gw.calls, ['session/projections', 'session/follow'])
  // The RPC is known to exist now; a later migration-required answer still falls back.
  gw.calls.length = 0
  assert.deepEqual(await projectionsOf(gw, 's2'), SNAPSHOT)
  assert.deepEqual(gw.calls, ['session/projections', 'session/follow'])
})

test('null (no such session) stays null', async () => {
  const gw = gateway(null)
  assert.equal(await projectionsOf(gw, 's1'), null)
})

// ── DSH 0.2: every in-process gateway call carries the owner Peer ──
import { withOwnerPeer } from '../lib/index.js'

test('withOwnerPeer: adds the owner Peer (0.2), leaves requests alone without one (0.1.7)', async () => {
  const seen = []
  const gateway = { async invoke(r) { seen.push(r); return 'ok' }, async stream(r) { seen.push(r); return 'st' } }
  const owner = { principal: { kind: 'owner' }, signal: new AbortController().signal }
  let peer = owner
  const gw = withOwnerPeer(gateway, () => peer)
  assert.equal(await gw.invoke({ namespace: 'session', method: 'prompt', args: {} }), 'ok')
  assert.equal(await gw.stream({ namespace: 'session', method: 'follow', args: {} }), 'st')
  assert.equal(seen[0].peer, owner)
  assert.equal(seen[1].peer, owner)
  // A caller that already names a peer keeps it.
  const other = { principal: { kind: 'guest' }, signal: new AbortController().signal }
  await gw.invoke({ namespace: 'session', method: 'page', args: {}, peer: other })
  assert.equal(seen[2].peer, other)
  // DSH 0.1.7: no browserPeer, so nothing is added (its gateway defaults to the operator).
  peer = undefined
  await gw.invoke({ namespace: 'session', method: 'page', args: {} })
  assert.equal('peer' in seen[3], false)
  assert.equal(withOwnerPeer(undefined, () => owner), undefined)
})
