// dsh-share-room guest page. Plain DOM, textContent only (no HTML string sinks),
// served under CSP script-src 'self'. Talks only to /share/<id>/*.
(() => {
  'use strict'
  const shareId = document.body.dataset.share
  const base = `/share/${shareId}/`
  const app = document.getElementById('app')

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v === true ? '' : String(v))
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)))
    return node
  }
  const clear = (node) => { while (node.firstChild) node.firstChild.remove() }
  const time = (at) => { try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
  const date = (at) => { try { return new Date(at).toLocaleString() } catch { return '' } }

  async function post(path, body) {
    const res = await fetch(base + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    let data = null
    try { data = await res.json() } catch {}
    return { ok: res.ok, status: res.status, data }
  }

  function notice(title, text) {
    clear(app)
    app.append(el('section', { class: 'card center', 'data-view': 'notice' }, el('h1', { text: title }), text && el('p', { class: 'muted', text })))
  }

  // The site switched sharing off: nothing is lost, it may come back.
  function paused(message, retry = () => location.reload()) {
    clear(app)
    const again = el('button', { class: 'primary', 'data-testid': 'retry', text: '重新整理' })
    again.addEventListener('click', () => retry())
    app.append(el('section', { class: 'card center', 'data-view': 'paused' },
      el('h1', { text: '分享暫停中' }),
      el('p', { class: 'muted', text: message || '分享者的網站目前關閉了分享功能。' }),
      el('p', { class: 'muted', text: '分享者重新開啟後，重新整理這一頁就能繼續。' }),
      again))
  }

  // ---------------------------------------------------------------------------
  // 1. Invite in the URL fragment → confirm → join (consumes it)

  async function confirmInvite(invite) {
    // Drop the secret from the address bar and history right away.
    history.replaceState(null, '', base)
    const info = await post('invite-info', { invite })
    if (info.status === 403 && info.data?.error === 'disabled') {
      // Not consumed: keep it in the address so a later reload can still use it.
      history.replaceState(null, '', base + '#' + invite)
      return paused(info.data.message)
    }
    if (!info.ok) {
      // Maybe this browser already joined; fall through to the room.
      const state = await fetch(base + 'state', { credentials: 'same-origin', cache: 'no-store' })
      if (state.ok) return room()
      return notice('連結無法使用', info.data?.message ?? '這個邀請連結無效、已用過或已過期。請向分享者索取新的連結。')
    }
    const { title, ownerName, guestName } = info.data
    clear(app)
    const button = el('button', { class: 'primary', 'data-testid': 'join', text: `以「${guestName}」加入` })
    const error = el('p', { class: 'error', role: 'alert' })
    button.addEventListener('click', async () => {
      button.disabled = true
      const res = await post('join', { invite })
      if (!res.ok) { button.disabled = false; error.textContent = res.data?.message ?? '無法加入。'; return }
      room()
    })
    app.append(el('section', { class: 'card center', 'data-view': 'confirm' },
      el('p', { class: 'muted', text: `${ownerName} 邀請你加入對話` }),
      el('h1', { text: title }),
      el('p', { text: '加入後可以一起討論，也可以請 AI 回答。這個連結只能用一次，請在你要使用的瀏覽器打開。' }),
      button, error))
  }

  // ---------------------------------------------------------------------------
  // 2. The room

  const state = { info: null, items: [], discussion: [], upTo: 0, mode: 'discuss', connected: false, busy: false, approval: new Set(), ended: false }
  let views = null
  let source = null

  function buildRoom() {
    clear(app)
    const header = el('header', { class: 'bar' })
    const log = el('div', { class: 'log', 'data-testid': 'log', 'aria-live': 'polite' })
    const status = el('div', { class: 'status' })
    const textarea = el('textarea', { rows: 2, maxlength: 4000, placeholder: '輸入訊息…', 'data-testid': 'input' })
    const modeButton = el('button', { type: 'button', class: 'mode', 'data-testid': 'mode' })
    const send = el('button', { type: 'submit', class: 'primary', text: '送出', 'data-testid': 'send' })
    const error = el('p', { class: 'error', role: 'alert' })
    const form = el('form', { class: 'composer' }, el('div', { class: 'row' }, modeButton, el('span', { class: 'hint' })), textarea, el('div', { class: 'row end' }, error, send))
    const footer = el('footer', {}, status, form)
    modeButton.addEventListener('click', () => { state.mode = state.mode === 'discuss' ? 'ai' : 'discuss'; render() })
    textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit() } })
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const text = textarea.value.trim()
      if (!text) return
      send.disabled = true
      error.textContent = ''
      const res = await post('say', { text, mode: state.mode })
      send.disabled = false
      if (!res.ok) { error.textContent = res.data?.message ?? `送出失敗（${res.status}）`; return }
      textarea.value = ''
      if (state.mode === 'ai') { state.busy = true; render() }
    })
    app.append(el('div', { class: 'room' }, header, log, footer))
    views = { header, log, status, textarea, modeButton, send, form, hint: form.querySelector('.hint') }
  }

  function bubble(kind, who, at, body, extra = {}) {
    return el('div', { class: `msg ${kind}`, ...extra },
      el('div', { class: 'meta' }, el('b', { text: who }), el('span', { class: 'muted', text: time(at) })),
      el('div', { class: 'body', text: body }))
  }

  function render() {
    if (!views) buildRoom()
    const { header, log, status, textarea, modeButton, send, form, hint } = views
    const info = state.info
    clear(header)
    header.append(
      el('div', {}, el('div', { class: 'title', text: info?.title ?? '分享的對話' }), el('div', { class: 'muted small', text: info ? `${info.ownerName} 分享 · 你是「${info.me.name}」` : '' })),
      el('a', { class: 'button', href: base + 'transcript.md', download: '', 'data-testid': 'download', text: '下載副本' }),
    )
    // Timeline: AI asks/answers/tools and 💬 discussion, merged by time.
    const rows = []
    const tools = new Map()
    for (const item of state.items) {
      if (item.kind === 'tool') tools.set(item.callId, { ...item, done: false, ok: true })
      if (item.kind === 'tool-done' && tools.has(item.callId)) Object.assign(tools.get(item.callId), { done: true, ok: item.ok })
    }
    let lastAt = 0
    for (const item of state.items) {
      if (item.at) lastAt = item.at
      if (item.kind === 'ask' || item.kind === 'answer') rows.push({ at: item.at ?? lastAt, order: 1, item })
      else if (item.kind === 'tool') rows.push({ at: item.at ?? lastAt, order: 1, item: tools.get(item.callId) })
    }
    for (const m of state.discussion) rows.push({ at: Date.parse(m.at) || 0, order: 0, discussion: m })
    rows.sort((a, b) => a.at - b.at || a.order - b.order)
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
    clear(log)
    if (rows.length === 0) log.append(el('p', { class: 'muted center', text: '還沒有任何訊息。' }))
    for (const row of rows) {
      if (row.discussion) {
        const m = row.discussion
        log.append(bubble(`discuss${m.seq <= state.upTo ? ' bundled' : ''}`, `💬 ${m.name}`, m.at, m.text, { 'data-discussion': m.seq }))
      } else if (row.item.kind === 'ask') {
        const i = row.item
        const node = bubble(`ask ${i.speaker.role}`, `🤖 ${i.speaker.name} 問 AI`, i.at, i.text, { 'data-seq': i.seq })
        if (i.discussion.length > 0) node.append(el('div', { class: 'muted small', text: `（附帶 ${i.discussion.length} 則討論）` }))
        log.append(node)
      } else if (row.item.kind === 'answer') {
        log.append(bubble('answer', 'AI', row.item.at, row.item.text, { 'data-seq': row.item.seq }))
      } else if (row.item.kind === 'tool') {
        const t = row.item
        log.append(el('div', { class: 'tool muted small', 'data-seq': t.seq, text: `⚙ ${t.label} ${t.done ? (t.ok ? '✓' : '✗') : '…'}` }))
      }
    }
    if (nearBottom) log.scrollTop = log.scrollHeight

    const active = info?.access === 'active'
    const statusText = []
    if (!active) statusText.push(info?.access === 'readonly' ? `分享已結束（${date(info.endedAt)}）。你仍可閱讀和下載副本。` : '分享已結束。')
    else {
      if (state.approval.size > 0) statusText.push('⏳ 等待分享者核准 AI 的操作')
      else if (state.busy) statusText.push('🤖 AI 處理中…')
      if (!state.connected) statusText.push('連線中斷，重新連線中…')
    }
    status.textContent = statusText.join('　')
    status.dataset.testid = 'status'
    form.hidden = !active
    if (active) {
      if (!info.aiAllowed && state.mode === 'ai') state.mode = 'discuss'
      modeButton.disabled = !info.aiAllowed
      modeButton.textContent = state.mode === 'discuss' ? '💬 討論' : '🤖 問 AI'
      modeButton.dataset.mode = state.mode
      hint.textContent = state.mode === 'discuss'
        ? (info.aiAllowed ? '大家即時看到，AI 不會回覆。點左邊切換成問 AI。' : '分享者沒有開放問 AI。')
        : `AI 會回覆，並讀到上次問 AI 之後的討論。剩 ${info.aiLeft} 次。`
      textarea.placeholder = state.mode === 'discuss' ? '和大家討論…' : '問 AI…'
    }
    send.disabled = false
  }

  function applyItems(items, reset) {
    if (reset) state.items = items
    else state.items.push(...items)
    // Busy = the last turn marker says a turn is running.
    for (const i of items) {
      if (i.kind === 'busy') state.busy = i.busy
      if (i.kind === 'approval') { if (i.pending) state.approval.add(i.id); else state.approval.delete(i.id) }
    }
    if (reset) {
      state.approval = new Set()
      let busy = false
      for (const i of items) {
        if (i.kind === 'busy') busy = i.busy
        if (i.kind === 'approval') { if (i.pending) state.approval.add(i.id); else state.approval.delete(i.id) }
      }
      state.busy = busy
    }
  }

  function connect() {
    source?.close()
    source = new EventSource(base + 'events')
    source.onopen = () => { state.connected = true; render() }
    source.onerror = async () => {
      state.connected = false
      source.close()
      // Why did it drop? Removed or ended shares answer without a stream.
      const res = await fetch(base + 'state', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null)
      if (res && res.status === 403) { const d = await res.json().catch(() => ({})); if (d.error === 'disabled') return paused(d.message) }
      if (res && res.status === 401) { const d = await res.json().catch(() => ({})); return notice(d.ended ? '分享已結束' : '你已不在這個分享中', d.ended ? '分享者已經結束這個分享。' : '分享者已將你移出這個分享。') }
      if (res && res.status === 410) {
        const d = await res.json().catch(() => ({}))
        return notice('分享已結束', d.state?.endedAt ? `結束於 ${date(d.state.endedAt)}。` : '')
      }
      render()
      setTimeout(connect, 2000)
    }
    source.onmessage = (event) => {
      let data
      try { data = JSON.parse(event.data) } catch { return }
      if (data.type === 'state') state.info = data.state
      else if (data.type === 'reset') applyItems(data.items, true)
      else if (data.type === 'items') applyItems(data.items, false)
      else if (data.type === 'discussion-reset') { state.discussion = data.messages; state.upTo = data.upTo }
      else if (data.type === 'discussion') { if (!state.discussion.some((m) => m.seq === data.message.seq)) state.discussion.push(data.message) }
      else if (data.type === 'bundled') state.upTo = Math.max(state.upTo, data.upTo)
      else if (data.type === 'removed') { source.close(); return notice('你已不在這個分享中', '分享者已將你移出這個分享。') }
      else if (data.type === 'disabled') { source.close(); return paused(data.message) }
      render()
    }
  }

  async function room() {
    const res = await fetch(base + 'state', { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) {
      const d = await res.json().catch(() => ({}))
      return notice(d.ended ? '分享已結束' : '需要邀請連結', d.ended ? '這個分享已經結束。' : '請使用分享者給你的邀請連結打開這個頁面。')
    }
    if (res.status === 410) return notice('分享已結束', '')
    if (res.status === 403) { const d = await res.json().catch(() => ({})); if (d.error === 'disabled') return paused(d.message) }
    if (!res.ok) return notice('暫時無法載入', `（${res.status}）請稍後重新整理。`)
    state.info = await res.json()
    render()
    connect()
  }

  const fragment = location.hash.slice(1)
  if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) confirmInvite(fragment)
  else room()
})()
