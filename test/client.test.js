// The hand-written Web client must parse and keep its tag parser in sync with core.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseTagged, tagContent } from '../lib/core.js'

function loadClient() {
  let factory
  const window = { __ModuleLoader__: { load: (m) => { assert.equal(m.id, 'dsh-share-room'); factory = m.factory } } }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, Symbol, Object, JSON })
  const React = { createElement() {}, useState() {}, useEffect() {}, useMemo() {}, useRef() {}, useCallback() {}, useSyncExternalStore() {} }
  return factory((id) => ({ react: React, 'react/jsx-runtime': { jsx() {}, jsxs() {}, Fragment: {} } })[id])
}

test('client loads and exports apply/inject', () => {
  const client = loadClient()
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual([...client.inject], ['slots', 'sessions', 'uiWorkspace'])
})

test('client parseTagged matches core', () => {
  const client = loadClient()
  const samples = [
    tagContent([{ type: 'text', text: 'q' }], { id: 'guest:a', name: '千佳', role: 'guest' }, [{ seq: 1, id: 'owner', name: 'C', role: 'owner', text: 'a\nb' }]).at(-1).text,
    tagContent([{ type: 'text', text: 'q' }], { id: 'owner', name: 'C', role: 'owner' }, []).at(-1).text,
    'plain', '<share_room_speaker>{"id":1}</share_room_speaker>', '<share_room_speaker>broken',
    '<share_room_speaker>{"id":"owner","name":"  Alice  ","role":"owner"}</share_room_speaker>',
    `<share_room_speaker>{"id":"${'x'.repeat(65)}","name":"A","role":"owner"}</share_room_speaker>`,
    '<share_room_speaker>{"id":"owner","name":"A\u202eB","role":"owner"}</share_room_speaker>',
    `<share_room_speaker>{"id":"owner","name":"${'長'.repeat(41)}","role":"owner"}</share_room_speaker>`,
  ]
  for (const text of samples) assert.deepEqual(JSON.parse(JSON.stringify(client.parseTagged(text) ?? null)), JSON.parse(JSON.stringify(parseTagged(text) ?? null)), text)
})

test('guest page script never uses innerHTML', () => {
  const src = readFileSync(new URL('../lib/guest/app.js', import.meta.url), 'utf8')
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src))
})
