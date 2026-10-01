// dsh-share-room: a small Markdown reader for AI answers on the guest page.
//
// It never produces HTML. `parse(text)` returns a plain tree of blocks and
// inline runs; the guest page turns that tree into DOM nodes with
// createElement + textContent, from a fixed list of tags. Links and images
// are shown as text (a guest can still copy a URL), raw HTML stays text.
//
// Blocks:  { t: 'h', level, c } | { t: 'p', c } | { t: 'ul', items: [c] }
//          | { t: 'ol', start, items: [c] } | { t: 'code', text }
//          | { t: 'quote', c: [blocks] } | { t: 'hr' }
//          | { t: 'table', head: [c], align: ['left'|'center'|'right'|''], rows: [[c]] }
// Inline c: array of strings and { t: 'b'|'i'|'s', c } | { t: 'code', text }
;(function (root) {
  'use strict'
  const MAX_DEPTH = 4

  function inline(src, depth = 0) {
    const out = []
    // A marker with no closer from position p has none from any later position
    // either: remember that, so a run of unmatched markers stays linear.
    const noClose = new Map()
    const closeOf = (m, from) => {
      if (from >= (noClose.get(m) ?? Infinity)) return -1
      const end = findClose(src, m, from)
      if (end < 0) noClose.set(m, Math.min(from, noClose.get(m) ?? Infinity))
      return end
    }
    let text = ''
    const flush = () => { if (text) { out.push(text); text = '' } }
    let i = 0
    while (i < src.length) {
      const ch = src[i]
      if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()#+\-.!|>]/.test(src[i + 1])) { text += src[i + 1]; i += 2; continue }
      if (ch === '`') {
        let n = 1; while (src[i + n] === '`') n++
        const fence = '`'.repeat(n)
        const end = src.indexOf(fence, i + n)
        if (end > i) { flush(); out.push({ t: 'code', text: src.slice(i + n, end).replace(/^ (.*) $/, '$1') }); i = end + n; continue }
      }
      if (depth < MAX_DEPTH) {
        const span = [['**', 'b'], ['__', 'b'], ['~~', 's'], ['*', 'i'], ['_', 'i']].find(([m]) => src.startsWith(m, i))
        if (span) {
          const [m, t] = span
          const start = i + m.length
          const end = closeOf(m, start)
          // `_` inside words (snake_case) is not emphasis.
          const wordy = m[0] === '_' && (/\w/.test(src[i - 1] ?? '') || /\w/.test(src[end + m.length] ?? ''))
          if (end > start && !/\s/.test(src[start]) && !/\s/.test(src[end - 1]) && !wordy) {
            flush(); out.push({ t, c: inline(src.slice(start, end), depth + 1) }); i = end + m.length; continue
          }
        }
      }
      if (ch === '!' && src[i + 1] === '[') { i++; continue } // image: keep the alt text and URL as text
      if (ch === '[') {
        const close = src.indexOf('](', i)
        const paren = close > i ? src.indexOf(')', close + 2) : -1
        if (close > i && paren > close && !src.slice(i + 1, close).includes('\n')) {
          const label = src.slice(i + 1, close)
          const url = src.slice(close + 2, paren).trim()
          flush()
          out.push(...inline(label, depth + 1))
          if (url && url !== label) text += ` (${url})`
          i = paren + 1
          continue
        }
      }
      text += ch
      i++
    }
    flush()
    return out
  }

  function findClose(src, marker, from) {
    let i = from
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue }
      if (src[i] === '`') { const end = src.indexOf('`', i + 1); if (end > 0) { i = end + 1; continue } }
      if (src.startsWith(marker, i) && !(marker.length === 1 && src[i + 1] === marker)) return i
      if (marker.length === 1 && src.startsWith(marker + marker, i)) { i += 2; continue }
      i++
    }
    return -1
  }

  const cells = (line) => {
    let s = line.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
    const out = []; let cur = ''
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
      if (s[i] === '|') { out.push(cur.trim()); cur = ''; continue }
      cur += s[i]
    }
    out.push(cur.trim())
    return out
  }
  const DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
  const LIST = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/
  const startsBlock = (line, next) => /^\s*(#{1,6}\s|```|~~~|>|(-{3,}|\*{3,}|_{3,})\s*$)/.test(line) || LIST.test(line) ||
    (line.includes('|') && next !== undefined && DELIM.test(next) && next.includes('-'))

  function blocks(lines, depth = 0) {
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^\s*$/.test(line)) { i++; continue }
      let m
      if ((m = /^\s*(```|~~~)/.exec(line))) {
        const fence = m[1]; const body = []
        i++
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++])
        i++
        out.push({ t: 'code', text: body.join('\n') })
        continue
      }
      if ((m = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { out.push({ t: 'h', level: m[1].length, c: inline(m[2]) }); i++; continue }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push({ t: 'hr' }); i++; continue }
      if (/^\s*>/.test(line)) {
        const body = []
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''))
        out.push(depth < MAX_DEPTH ? { t: 'quote', c: blocks(body, depth + 1) } : { t: 'p', c: inline(body.join('\n')) })
        continue
      }
      if (line.includes('|') && i + 1 < lines.length && DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = cells(line)
        const align = cells(lines[i + 1]).map((d) => d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : '')
        i += 2
        const rows = []
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          const row = cells(lines[i++])
          rows.push(head.map((_, k) => inline(row[k] ?? '')))
        }
        out.push({ t: 'table', head: head.map((h) => inline(h)), align: head.map((_, k) => align[k] ?? ''), rows })
        continue
      }
      if ((m = LIST.exec(line))) {
        const ordered = m[3] !== undefined
        const items = []
        while (i < lines.length && (m = LIST.exec(lines[i])) && (m[3] !== undefined) === ordered) {
          const body = [m[4]]; i++
          // Indented continuation lines belong to the item.
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i])) body.push(lines[i++].trim())
          items.push(inline(body.join('\n')))
        }
        out.push(ordered ? { t: 'ol', start: Number(LIST.exec(line)[3]), items } : { t: 'ul', items })
        continue
      }
      const body = [line]; i++
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !startsBlock(lines[i], lines[i + 1])) body.push(lines[i++])
      out.push({ t: 'p', c: inline(body.join('\n')) })
    }
    return out
  }

  function parse(text) {
    return blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'))
  }

  root.shareRoomMarkdown = Object.freeze({ parse })
})(typeof globalThis !== 'undefined' ? globalThis : this)
