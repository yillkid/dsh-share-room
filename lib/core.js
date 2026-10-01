// dsh-share-room pure core: credentials, names, speaker tagging, discussion
// bundling and the guest event whitelist. No Cordis, no I/O: unit-tested directly.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SPEAKER_OPEN = '<share_room_speaker>'
export const SPEAKER_CLOSE = '</share_room_speaker>'
export const DISCUSSION_OPEN = '<share_room_discussion>'
export const DISCUSSION_CLOSE = '</share_room_discussion>'

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const SHARE_ID = /^[A-Za-z0-9_-]{16,64}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

// ---------------------------------------------------------------------------
// Ids and credentials

/** 32 random bytes, base64url (43 chars). */
export function newSecret() {
  return randomBytes(32).toString('base64url')
}

/** Non-secret public id (share id, guest id). */
export function newId(bytes = 12) {
  return randomBytes(bytes).toString('base64url')
}

/** Only hashes of bearer credentials are ever stored. */
export function hashSecret(secret) {
  return createHash('sha256').update(`dsh-share-room\n${secret}`).digest('base64url')
}

export function validSecret(value) {
  return typeof value === 'string' && SECRET.test(value)
}

export function secretMatches(secret, hash) {
  if (!validSecret(secret) || typeof hash !== 'string') return false
  const a = Buffer.from(hashSecret(secret))
  const b = Buffer.from(hash)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export function validShareId(value) {
  return typeof value === 'string' && SHARE_ID.test(value)
}

/** Display name: controls and bidi overrides stripped, whitespace collapsed, 1..40 chars. */
export function cleanName(name) {
  if (typeof name !== 'string') return undefined
  const value = name.replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  if (value === '' || [...value].length > 40) return undefined
  return value
}

/** Free text from a person: normalized newlines, controls stripped (newline/tab kept). */
export function cleanText(text, maxChars) {
  if (typeof text !== 'string') return undefined
  const value = text.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim()
  if (value === '' || value.length > maxChars) return undefined
  return value
}

export function parseCookies(header) {
  const out = new Map()
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = part.slice(0, at).trim()
    if (!out.has(key)) out.set(key, part.slice(at + 1).trim())
  }
  return out
}

export const guestCookieName = (shareId) => `share_room_${shareId}`

// ---------------------------------------------------------------------------
// Speaker tagging (ported from swarm-room)

/** JSON with `<`, `>`, `&` escaped: the value can never close or open a tag. */
export function tagJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

const RESERVED_TAG = /<(\s*\/?\s*share_room_(?:speaker|discussion))/gi

/** Neutralize user-typed room tags so only the plugin's own part is a real tag. */
export function neutralize(text) {
  return String(text).replace(RESERVED_TAG, '\uFF1C$1')
}

export function speakerTag(speaker) {
  return `${SPEAKER_OPEN}${tagJson({ id: speaker.id, name: speaker.name, role: speaker.role })}${SPEAKER_CLOSE}`
}

/** One escaped JSON line per entry; oldest drop first past `maxChars`. */
export function discussionBlock(entries, { maxChars = 24_000 } = {}) {
  if (entries.length === 0) return ''
  const lines = entries.map((e) => tagJson({ name: e.name, id: e.id, at: e.at, text: e.text }))
  let omitted = 0
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  while (lines.length > 1 && total > maxChars) {
    total -= lines.shift().length + 1
    omitted++
  }
  const head = omitted > 0 ? `${tagJson({ omitted })}\n` : ''
  return `${DISCUSSION_OPEN}\n${head}${lines.join('\n')}\n${DISCUSSION_CLOSE}`
}

/**
 * Tagged prompt content: the person's parts with reserved tags neutralized,
 * then ONE trailing text part with the speaker tag and pending discussion.
 * Trailing, because DSH titles a session from the first words of its first prompt.
 */
export function tagContent(content, speaker, discussion = []) {
  if (!Array.isArray(content)) throw new TypeError('content must be an array')
  const block = discussionBlock(discussion)
  const rest = content.map((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    ? { ...part, text: neutralize(part.text) }
    : part)
  return [...rest, { type: 'text', text: `${speakerTag(speaker)}${block === '' ? '' : `\n${block}`}` }]
}

function validSpeaker(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string' && value.id.length <= 64 &&
    typeof value.name === 'string' && cleanName(value.name) === value.name &&
    (value.role === 'owner' || value.role === 'guest')
}

/** Parse one metadata text part (must start with the speaker tag). */
export function parseTagged(text) {
  if (typeof text !== 'string' || !text.startsWith(SPEAKER_OPEN)) return undefined
  const end = text.indexOf(SPEAKER_CLOSE)
  if (end < 0) return undefined
  let speaker
  try { speaker = JSON.parse(text.slice(SPEAKER_OPEN.length, end)) } catch { return undefined }
  if (!validSpeaker(speaker)) return undefined
  let rest = text.slice(end + SPEAKER_CLOSE.length).replace(/^\n/, '')
  let discussion = []
  if (rest.startsWith(DISCUSSION_OPEN)) {
    const close = rest.indexOf(DISCUSSION_CLOSE)
    if (close >= 0) {
      discussion = rest.slice(DISCUSSION_OPEN.length, close).split('\n').filter(Boolean).flatMap((line) => {
        try {
          const row = JSON.parse(line)
          return typeof row.text === 'string' && typeof row.name === 'string' ? [{ name: row.name, text: row.text }] : []
        } catch { return [] }
      })
      rest = rest.slice(close + DISCUSSION_CLOSE.length).replace(/^\n/, '')
    }
  }
  return { speaker: { id: speaker.id, name: speaker.name, role: speaker.role }, discussion }
}

/** Split stored user content: metadata is the LAST text part, and only if it parses. */
export function splitTagged(content) {
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (part === null || typeof part !== 'object' || part.type !== 'text') continue
    const parsed = parseTagged(part.text)
    if (parsed === undefined) return undefined
    return { ...parsed, content: [...content.slice(0, i), ...content.slice(i + 1)] }
  }
  return undefined
}

/** Session title from a person's own words (DSH's fallback would include the tag). */
export function titleFrom(content, { maxWords = 5, maxBytes = 40 } = {}) {
  if (!Array.isArray(content)) return ''
  const text = content.filter((p) => p !== null && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text).join(' ').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim()
  let out = ''
  let used = 0
  for (const ch of text.split(' ').filter(Boolean).slice(0, maxWords).join(' ')) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (used + bytes > maxBytes) break
    out += ch
    used += bytes
  }
  return out.trimEnd()
}

// ---------------------------------------------------------------------------
// Guest view: the ONLY place session events become guest-visible.
//
// A whitelist over DSH session events. Anything not handled here is dropped,
// including every event type a future DSH adds. Never forwards: system
// prompts, runtime context, request headers, reasoning, tool arguments, tool
// output, error details, model/provider identity or usage.

const TOOL_LABELS = Object.freeze({
  bash: '執行指令', shell: '執行指令', read: '讀取檔案', write: '寫入檔案', edit: '編輯檔案',
  glob: '搜尋檔案', grep: '搜尋內容', web_search: '搜尋網路', web_fetch: '讀取網頁',
  subagent: '委派子代理', todo_write: '更新待辦', present: '提供檔案', read_image: '讀取圖片',
})

/** A tool's guest label: a fixed table, else a generic one (names can be user-defined). */
export function toolLabel(name) {
  return Object.hasOwn(TOOL_LABELS, name) ? TOOL_LABELS[name] : '使用工具'
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((p) => p !== null && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text).join('\n')
}

function attachmentNote(content) {
  if (!Array.isArray(content)) return []
  const notes = []
  for (const p of content) {
    if (p === null || typeof p !== 'object' || p.type === 'text') continue
    notes.push(p.type === 'image' ? '[圖片]' : '[附件]')
  }
  return notes
}

/**
 * Map ONE session event to zero or more guest items.
 * @param event - `{type, seq, time, data}` from session/follow or session/page.
 * @param owner - `{name}` shown for untagged (owner-typed) user messages.
 * @returns array of guest items; empty for anything not whitelisted.
 */
export function guestItems(event, owner) {
  if (event === null || typeof event !== 'object' || !Number.isInteger(event.seq)) return []
  const { type, seq, time, data } = event
  const at = Number.isFinite(time) ? time : undefined
  if (data === null || typeof data !== 'object') return []
  switch (type) {
    case 'user/message': {
      // Only messages a person typed. Runtime context, subagent results and
      // other synthesized user-role messages carry another source kind.
      if (data.source?.kind !== 'user') return []
      const split = splitTagged(data.content)
      const content = split ? split.content : data.content
      const text = [textOf(content), ...attachmentNote(content)].filter(Boolean).join('\n')
      const speaker = split ? { name: split.speaker.name, role: split.speaker.role } : { name: owner.name, role: 'owner' }
      return [{ kind: 'ask', seq, at, speaker, text, discussion: split ? split.discussion : [] }]
    }
    case 'assistant/message': {
      const message = data.message
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) return []
      const out = []
      const text = textOf(message.content)
      if (text.trim() !== '') out.push({ kind: 'answer', seq, at, text })
      return out
    }
    case 'tool/call': {
      if (typeof data.name !== 'string') return []
      return [{ kind: 'tool', seq, at, callId: String(data.callId ?? ''), label: toolLabel(data.name) }]
    }
    case 'tool/result': {
      const callId = data.message?.toolCallId ?? data.message?.source?.callId
      if (typeof callId !== 'string') return []
      return [{ kind: 'tool-done', seq, at, callId, ok: data.message?.isError !== true }]
    }
    case 'turn/start':
      return [{ kind: 'busy', seq, at, busy: true }]
    case 'turn/end': {
      const reason = data.reason?.kind
      return [{ kind: 'busy', seq, at, busy: false, failed: reason === 'error', cancelled: reason === 'cancelled' }]
    }
    case 'approval/asked':
      return [{ kind: 'approval', seq, at, id: String(data.id ?? ''), pending: true }]
    case 'approval/decided':
      return [{ kind: 'approval', seq, at, id: String(data.id ?? ''), pending: false }]
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Markdown transcript (guest download)

export function transcriptMarkdown({ title, items, discussion, endedAt }) {
  const lines = [`# ${title.replace(/\n/g, ' ')}`, '']
  const rows = [
    ...items.filter((i) => i.kind === 'ask' || i.kind === 'answer').map((i) => ({ at: i.at ?? 0, order: 1, i })),
    ...discussion.map((d) => ({ at: Date.parse(d.at) || 0, order: 0, d })),
  ].sort((a, b) => a.at - b.at || a.order - b.order)
  const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '')
  for (const row of rows) {
    if (row.d) lines.push(`**💬 ${row.d.name}** · ${when(row.at)}`, '', row.d.text, '')
    else if (row.i.kind === 'ask') lines.push(`**🤖 ${row.i.speaker.name} 問 AI** · ${when(row.at)}`, '', row.i.text, '')
    else lines.push(`**AI** · ${when(row.at)}`, '', row.i.text, '')
  }
  if (endedAt) lines.push('---', '', `分享已於 ${when(endedAt)} 結束。`, '')
  return lines.join('\n')
}
