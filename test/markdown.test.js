import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import '../lib/guest/markdown.js'

const { parse } = globalThis.shareRoomMarkdown
// Flatten inline runs to text, to check nothing is lost or invented.
const flat = (c) => c.map((r) => typeof r === 'string' ? r : r.t === 'code' ? r.text : flat(r.c)).join('')

test('markdown: headings, emphasis, lists, code, quote, rule', () => {
  const out = parse('# 標題\n\n**粗** 與 *斜* 與 ~~刪~~ 與 `碼`\n\n- 一\n- 二\n\n3. 三\n4. 四\n\n```js\nconst a = 1 < 2\n```\n\n> 引用\n\n---')
  assert.deepEqual(out.map((b) => b.t), ['h', 'p', 'ul', 'ol', 'code', 'quote', 'hr'])
  assert.equal(out[0].level, 1)
  assert.deepEqual(out[1].c.filter((r) => typeof r !== 'string').map((r) => r.t), ['b', 'i', 's', 'code'])
  assert.deepEqual(out[2].items.map(flat), ['一', '二'])
  assert.equal(out[3].start, 3)
  assert.equal(out[4].text, 'const a = 1 < 2')
})

test('markdown: tables with alignment, escaped pipes and short rows', () => {
  const [t] = parse('| 項目 | 金額 | 備註 |\n|---|---:|:-:|\n| 帳篷 | 8,000 | a \\| b |\n| **合計** | **20,000** |')
  assert.equal(t.t, 'table')
  assert.deepEqual(t.head.map(flat), ['項目', '金額', '備註'])
  assert.deepEqual(t.align, ['', 'right', 'center'])
  assert.deepEqual(t.rows.map((r) => r.map(flat)), [['帳篷', '8,000', 'a | b'], ['合計', '20,000', '']])
  assert.equal(t.rows[1][0][0].t, 'b')
})

test('markdown: links and images become text; HTML stays text', () => {
  const [p] = parse('看 [這裡](https://evil.example/x) 和 ![圖](javascript:alert(1)) <img src=x onerror=alert(1)>')
  const text = flat(p.c)
  assert.ok(p.c.every((r) => typeof r === 'string' || ['b', 'i', 's', 'code'].includes(r.t)), 'no link/image nodes')
  assert.match(text, /這裡 \(https:\/\/evil\.example\/x\)/)
  assert.match(text, /<img src=x onerror=alert\(1\)>/)
})

test('markdown: snake_case is not emphasis; unclosed markers stay literal', () => {
  assert.equal(flat(parse('a_b_c')[0].c), 'a_b_c')
  assert.equal(parse('a_b_c')[0].c.length, 1)
  assert.equal(flat(parse('**沒關')[0].c), '**沒關')
  assert.equal(flat(parse('2 * 3 * 4')[0].c), '2 * 3 * 4')
})

test('markdown: deep nesting and huge input terminate', () => {
  const deep = '>'.repeat(5000) + ' x'
  assert.ok(parse(deep).length >= 1)
  const big = ('**a** _b_ `c` [d](e) | x |\n').repeat(4000)
  const t = Date.now(); parse(big); assert.ok(Date.now() - t < 2000)
  assert.ok(parse('*'.repeat(20000)).length >= 1)
  // Unmatched markers must stay linear (this was quadratic: ~16 s).
  for (const s of ['**a '.repeat(20000), '**_~~*a '.repeat(10000), '[a '.repeat(20000) + '](x']) {
    const t0 = Date.now(); parse(s); assert.ok(Date.now() - t0 < 2000, s.slice(0, 8))
  }
})

test('markdown and guest scripts never build HTML from strings', () => {
  for (const f of ['../lib/guest/markdown.js', '../lib/guest/app.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\(['"]on|\.href\s*=/.test(src), f)
  }
})
