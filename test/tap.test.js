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
