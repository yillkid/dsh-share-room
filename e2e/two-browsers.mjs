// Two-browser end-to-end check against a running DSH with dsh-share-room and a
// deterministic fake model (see e2e/README.md).
//   SHARE_ROOM_BASE=http://localhost:18997 SHARE_ROOM_PASSWORD=... node e2e/two-browsers.mjs
// Playwright is resolved from PLAYWRIGHT_FROM (a node_modules dir) or the cwd.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${process.cwd()}/`)
const { chromium } = require('playwright')
const B = process.env.SHARE_ROOM_BASE ?? 'http://localhost:18997'
const PASSWORD = process.env.SHARE_ROOM_PASSWORD
const SHOTS = process.env.SHARE_ROOM_SHOTS
if (!PASSWORD) throw new Error('set SHARE_ROOM_PASSWORD')
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const tag = `e2e-${Date.now().toString(36)}`
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }
const step = (s) => console.log(`· ${s}`)

const browser = await chromium.launch()
const errors = []
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|EventSource|net::ERR/.test(m.text())) errors.push(`${who} console: ${m.text()}`) })
}
try {
  // ---- owner C -------------------------------------------------------------
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-TW' })
  const owner = await ownerCtx.newPage(); watch(owner, 'owner')
  await owner.goto(`${B}/auth/login`)
  await owner.locator('input[type=password]').fill(PASSWORD)
  const user = owner.locator('input[name=username]'); if (await user.count()) await user.fill('admin')
  await owner.locator('button[type=submit]').click()
  await owner.waitForURL((u) => !u.pathname.startsWith('/auth/'), { timeout: 30_000 })
  step('owner logged in')

  // A fresh source session A with history (one tool call whose output must
  // stay private), created through the owner's own authenticated API.
  const rpc = (method, request) => owner.evaluate(async ([method, request]) => {
    const r = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) })
    const j = await r.json()
    if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j)}`)
    return j.result.value
  }, [method, request])
  const source = (await rpc('session/create', {})).sessionId
  // DSH 0.1.7 has session/projections; on 0.1.5 find the cursor by probing page.
  const cursorOf = async (id) => {
    try { return (await rpc('session/projections', { sessionId: id })).asOfSeq } catch {}
    let lo = -1, hi = 1
    const ok = async (n) => { try { await rpc('session/page', { address: { kind: 'session', sessionId: id }, throughSeq: n, maxMessages: 1 }); return true } catch { return false } }
    while (await ok(hi)) { lo = hi; hi *= 2 }
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await ok(mid)) lo = mid; else hi = mid }
    return lo
  }
  const waitTurns = async (n) => {
    for (let i = 0; i < 60; i++) {
      const page = await rpc('session/page', { address: { kind: 'session', sessionId: source }, throughSeq: await cursorOf(source), maxMessages: 80 })
      if (page.records.filter((r) => r.event?.type === 'turn/end').length >= n) return
      await owner.waitForTimeout(500)
    }
    throw new Error('source turns did not finish')
  }
  // (The fake model answers the LAST user message; turn 1's is the runtime context.)
  await rpc('session/prompt', { requestId: crypto.randomUUID(), sessionId: source, mode: 'queue', content: [{ type: 'text', text: `hello ${tag}` }] })
  await waitTurns(1)
  await rpc('session/prompt', { requestId: crypto.randomUUID(), sessionId: source, mode: 'queue', content: [{ type: 'text', text: 'RUN: echo SECRET_OUTPUT_123' }] })
  await waitTurns(2)
  await rpc('session/rename', { sessionId: source, title: tag })
  await owner.reload()
  // DSH 0.1.5 shows a one-time beta notice over the GUI.
  const notice = owner.getByRole('button', { name: /^(继续|繼續|Continue)$/ })
  if (await notice.first().waitFor({ timeout: 5_000 }).then(() => true, () => false)) await notice.first().click()
  const group = owner.getByText(/^未分[組组]$/).first()
  await group.waitFor({ timeout: 20_000 })
  if (!(await owner.getByText(tag, { exact: true }).count())) await group.click()
  await owner.getByText(tag, { exact: true }).first().click()
  await shot(owner, '00-source')
  await owner.getByText('工具結果長度').first().waitFor({ timeout: 30_000 })
  step('source session has history')
  const shareButton = owner.locator('[data-testid=share-room-share-button]')
  await shareButton.waitFor({ timeout: 15_000 })
  await shareButton.click()
  await owner.locator('[data-share-room=owner-name]').fill('小明')
  await owner.locator('[data-share-room=guest-name]').fill('千佳')
  await shot(owner, '01-create')
  await owner.locator('[data-share-room=create]').click()
  const linkBox = owner.locator('[data-share-room=link]')
  await linkBox.waitFor({ timeout: 20_000 }).catch(async (error) => {
    await shot(owner, '02-create-failed')
    const why = await owner.locator('[data-testid=share-room-create] [role=alert]').textContent({ timeout: 2_000 }).catch(() => null)
    throw new Error(`share was not created${why ? `: ${why}` : ''}`, { cause: error })
  })
  const link = await linkBox.inputValue()
  assert.match(link, /\/share\/[A-Za-z0-9_-]+\/#[A-Za-z0-9_-]{43}$/)
  await shot(owner, '02-created')
  await owner.locator('[data-share-room=open-shared]').click()
  const manage = owner.locator('[data-testid=share-room-manage-button]')
  await manage.waitFor({ timeout: 20_000 })
  assert.match(await manage.textContent(), /分享中 · 0 位訪客/)
  // The shared session runs read-only; the original keeps its own permission.
  const permissionOf = (id) => owner.evaluate(async (id) => (await (await fetch(`/api/share-room.state?sessionId=${encodeURIComponent(id)}`)).json()).permission, id)
  const sharedNow = await owner.evaluate(async (src) => {
    const r = await fetch(`/api/share-room.state?sessionId=${encodeURIComponent(src)}`)
    return (await r.json()).fromHere?.[0]?.sessionId
  }, source)
  assert.ok(sharedNow && sharedNow !== source, 'the share lives in a forked session')
  assert.equal(await permissionOf(sharedNow), 'read-only', 'shared session is read-only')
  assert.notEqual(await permissionOf(source), 'read-only', 'source session permission untouched')
  // The invite link never enters the conversation.
  assert.equal(await owner.getByText(link.split('#')[1]).count(), 0)
  step('share created, owner switched to shared session')

  // ---- guest D (separate browser context, no DSH login) ----------------------
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true })
  const guest = await guestCtx.newPage(); watch(guest, 'guest')
  await guest.goto(link)
  try { await guest.locator('[data-testid=join]').waitFor({ timeout: 15_000 }) } catch (e) { await shot(guest, 'fail-join'); console.log('guest body:', await guest.locator('body').innerText()); throw e }
  assert.ok(!guest.url().includes('#'), 'secret stays out of the address bar')
  await shot(guest, '03-guest-confirm')
  await guest.locator('[data-testid=join]').click()
  await guest.locator('[data-testid=log]').waitFor({ timeout: 15_000 })
  await guest.getByText('RUN: echo SECRET_OUTPUT_123').waitFor({ timeout: 15_000 })
  await guest.getByText('工具結果長度').first().waitFor({ timeout: 15_000 })
  const guestText = await guest.locator('body').innerText()
  assert.equal(guestText.split('SECRET_OUTPUT_123').length - 1, 1, 'guest sees the typed command once, never the tool output')
  assert.ok(!guestText.includes('You are an AI'), 'no system prompt')
  // (The fake model echoes its input, so AI *answers* may quote the runtime
  // context; answers are meant to be visible. Nothing else may carry it.)
  const nonAnswers = await guest.locator('.log > :not(.answer)').allInnerTexts()
  assert.ok(!nonAnswers.join('\n').includes('runtime context'), 'runtime context never shown as a message')
  await shot(guest, '04-guest-room')
  step('guest joined and sees whitelisted history')
  await manage.filter({ hasText: '1 位訪客' }).waitFor({ timeout: 10_000 })

  // The same link cannot be used again (fresh browser).
  const thief = await (await browser.newContext()).newPage()
  await thief.goto(link)
  await thief.getByText('連結無法使用').waitFor({ timeout: 15_000 })
  step('invite is single-use')

  // Guest cannot reach the owner's DSH.
  const apiStatus = await guest.evaluate(async () => (await fetch('/api/share-room.state?sessionId=x')).status)
  assert.ok(apiStatus === 401 || apiStatus === 302 || apiStatus === 403, `guest /api status ${apiStatus}`)

  // ---- 💬 discussion both ways ------------------------------------------------
  await guest.locator('[data-testid=input]').fill('我覺得方案 A 比較好')
  await guest.locator('[data-testid=send]').click()
  await owner.locator('[data-share-room=discussion]').getByText('我覺得方案 A 比較好').waitFor({ timeout: 10_000 })
  const ownerInput = owner.getByRole('textbox').last()
  assert.equal(await owner.locator('[data-share-room=mode]').getAttribute('data-mode'), 'discuss')
  await ownerInput.fill('我比較偏向 B')
  await ownerInput.press('Enter')
  await guest.getByText('我比較偏向 B').waitFor({ timeout: 10_000 })
  await owner.waitForTimeout(800)
  assert.equal(await owner.locator('[data-share-room=speaker]').count(), 0, '💬 never reaches the AI')
  await shot(owner, '05-owner-discussion')
  step('💬 discussion is live both ways and does not reach the AI')

  // ---- 🤖 guest asks AI ---------------------------------------------------------
  await guest.locator('[data-testid=mode]').click()
  await guest.locator('[data-testid=input]').fill('請比較 A 和 B')
  await guest.locator('[data-testid=send]').click()
  await owner.locator('[data-share-room=speaker]').filter({ hasText: '千佳（訪客）' }).waitFor({ timeout: 20_000 })
  await owner.getByText('附帶 2 則討論').waitFor({ timeout: 10_000 })
  await guest.locator('.msg.answer').filter({ hasText: 'ECHO[' }).last().waitFor({ timeout: 30_000 })
  await shot(owner, '06-owner-guest-asked')
  await shot(guest, '07-guest-answer')
  step('guest 🤖 question tagged with speaker and bundled discussion')

  // ---- owner 🤖 -----------------------------------------------------------------
  await owner.locator('[data-share-room=mode]').click()
  await ownerInput.fill('我也問一下 AI')
  await ownerInput.press('Enter')
  await guest.locator('.msg.ask.owner').filter({ hasText: '我也問一下 AI' }).waitFor({ timeout: 20_000 })
  assert.match(await guest.locator('.msg.ask.owner').last().textContent(), /小明/)
  step('owner 🤖 shows as 小明 to the guest')

  // ---- second guest: reissue revokes the old link; removal is immediate -----------
  await manage.click()
  const issue = async (name) => {
    await owner.locator('[data-share-room=invite-name]').fill(name)
    await owner.locator('[data-share-room=invite]').click()
    await owner.waitForFunction((n) => document.querySelector('[data-testid=share-room-manage]')?.textContent.includes(`給「${n}」的連結`), name, { timeout: 10_000 })
    return owner.locator('[data-share-room=link]').inputValue()
  }
  const oldLink = await issue('阿華')
  const newLink = await issue('阿華')
  assert.notEqual(oldLink, newLink)
  await owner.keyboard.press('Escape')
  const huaCtx = await browser.newContext()
  const stale = await huaCtx.newPage(); watch(stale, 'hua-old')
  await stale.goto(oldLink)
  await stale.getByText('連結無法使用').waitFor({ timeout: 15_000 })
  await stale.close()
  // (A fragment-only change would not reload the page, so use a fresh tab.)
  const hua = await huaCtx.newPage(); watch(hua, 'hua')
  await hua.goto(newLink)
  await hua.locator('[data-testid=join]').click()
  await hua.locator('[data-testid=log]').waitFor({ timeout: 15_000 })
  await manage.filter({ hasText: '2 位訪客' }).waitFor({ timeout: 10_000 })
  await hua.locator('[data-testid=input]').fill('阿華來了')
  await hua.locator('[data-testid=send]').click()
  await guest.getByText('阿華來了').waitFor({ timeout: 10_000 })
  await manage.click()
  const row = owner.locator('[data-testid=share-room-manage] div').filter({ hasText: /^阿華移除$/ })
  await row.locator('[data-share-room=remove-guest]').click()
  await hua.getByText('你已不在這個分享中').waitFor({ timeout: 10_000 })
  const huaSay = await hua.evaluate(async () => (await fetch(location.pathname + 'say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', mode: 'discuss' }) })).status)
  assert.equal(huaSay, 401)
  await manage.filter({ hasText: '1 位訪客' }).waitFor({ timeout: 10_000 })
  await owner.keyboard.press('Escape')
  step('reissued link revokes the old one; second guest removed immediately, first guest unaffected')

  // ---- AI switch off → guest can only discuss ------------------------------------
  await manage.click()
  await owner.locator('[data-share-room=toggle-ai]').uncheck()
  await guest.waitForFunction(() => document.querySelector('[data-testid=mode]')?.disabled === true, null, { timeout: 10_000 })
  await owner.locator('[data-share-room=toggle-ai]').check()
  await guest.waitForFunction(() => document.querySelector('[data-testid=mode]')?.disabled === false, null, { timeout: 10_000 })
  step('AI switch takes effect for the guest immediately')

  // ---- end share → guest read-only immediately -----------------------------------
  owner.once('dialog', (d) => d.accept())
  await owner.locator('[data-share-room=end]').click()
  await guest.getByText(/分享已結束/).first().waitFor({ timeout: 10_000 })
  assert.equal(await guest.locator('[data-testid=input]').isVisible(), false)
  await shot(guest, '08-guest-ended')
  const say = await guest.evaluate(async () => (await fetch(location.pathname + 'say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', mode: 'discuss' }) })).status)
  assert.equal(say, 409)
  const download = await guest.evaluate(async () => { const r = await fetch(location.pathname + 'transcript.md'); return { status: r.status, text: await r.text() } })
  assert.equal(download.status, 200)
  assert.match(download.text, /請比較 A 和 B/)
  assert.equal(download.text.split('SECRET_OUTPUT_123').length - 1, 1)
  step('ending is immediate; read-only page and download remain')

  // ---- delete read-only page → gone ----------------------------------------------
  owner.once('dialog', (d) => d.accept())
  await owner.locator('[data-share-room=delete]').click()
  await guest.reload()
  await guest.getByText('分享已結束').first().waitFor({ timeout: 10_000 })
  const gone = await guest.evaluate(async () => (await fetch(location.pathname + 'state')).status)
  assert.equal(gone, 410)
  step('read-only page deleted')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('E2E OK')
} finally {
  await browser.close()
}
