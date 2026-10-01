// Demo run: owner (desktop) + two guests (phones), recorded and screenshotted.
// Needs a THROWAWAY DSH with dsh-share-room and demo/demo-llm.mjs as its model
// (see demo/README.md). Never point it at a real DSH.
// Writes OUT/{owner,mei,hua}.webm, OUT/shots/*.png, OUT/captions.json
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? `${process.cwd()}/`)
const { chromium } = require('playwright')
const B = process.env.BASE ?? 'http://localhost:18994'
const OUT = process.env.OUT ?? 'demo-out'
const PASSWORD = process.env.SHARE_ROOM_PASSWORD
if (!PASSWORD) throw new Error('set SHARE_ROOM_PASSWORD')
mkdirSync(`${OUT}/shots`, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch()

// ---- setup (not recorded): login and a private conversation with history ----
const setupCtx = await browser.newContext({ locale: 'zh-TW' })
const setup = await setupCtx.newPage()
await setup.goto(`${B}/auth/login`)
await setup.locator('input[type=password]').fill(PASSWORD)
const u = setup.locator('input[name=username]'); if (await u.count()) await u.fill('admin')
await setup.locator('button[type=submit]').click()
await setup.waitForURL((x) => !x.pathname.startsWith('/auth/'), { timeout: 30_000 })
const rpc = (method, request) => setup.evaluate(async ([method, request]) => {
  const r = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) })
  const j = await r.json(); if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j)}`); return j.result.value
}, [method, request])
await setup.evaluate(() => fetch('/api/share-room.site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }))
await setup.evaluate(() => fetch('/api/share-room.owner-name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '小明' }) }))
const source = (await rpc('session/create', {})).sessionId
await rpc('session/prompt', { requestId: crypto.randomUUID(), sessionId: source, mode: 'queue', content: [{ type: 'text', text: '幫我規劃一個週末的社區市集活動' }] })
await wait(6000)
await rpc('session/rename', { sessionId: source, title: '週末社區市集企劃' })
const state = await setupCtx.storageState()
await setupCtx.close()

// ---- recorded contexts ----------------------------------------------------------
const OWNER = { width: 1280, height: 800 }, PHONE = { width: 390, height: 800 }
const rec = (size) => ({ dir: `${OUT}/raw-${size.width}`, size })
const ownerCtx = await browser.newContext({ storageState: state, viewport: OWNER, locale: 'zh-TW', recordVideo: rec(OWNER) })
const meiCtx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, locale: 'zh-TW', recordVideo: { dir: `${OUT}/raw-mei`, size: PHONE } })
const huaCtx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, locale: 'zh-TW', recordVideo: { dir: `${OUT}/raw-hua`, size: PHONE } })
const t0 = Date.now()
const captions = []
let open
const caption = (text) => { const t = (Date.now() - t0) / 1000; if (open) open.end = t; open = { start: t, end: t + 60, text }; captions.push(open) }
const shot = (page, name) => page.screenshot({ path: `${OUT}/shots/${name}.png` })
const idle = (who) => `<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:16px system-ui,'WenQuanYi Zen Hei';color:#888;background:#f6f7f9">${who}的手機<br>等待邀請連結…</body></html>`

const owner = await ownerCtx.newPage()
const mei = await meiCtx.newPage(); await mei.setContent(idle('小美'))
const hua = await huaCtx.newPage(); await hua.setContent(idle('阿華'))

caption('小明正在和 AI 規劃週末市集，想找朋友一起討論')
await owner.goto(B)
const notice = owner.getByRole('button', { name: /^(继续|繼續|Continue)$/ })
if (await notice.first().waitFor({ timeout: 4000 }).then(() => true, () => false)) await notice.first().click()
const group = owner.getByText(/^未分[組组]$/).first()
await group.waitFor({ timeout: 20_000 })
if (!(await owner.getByText('週末社區市集企劃', { exact: true }).count())) await group.click()
await owner.getByText('週末社區市集企劃', { exact: true }).first().click()
await owner.getByText('街角小市集').first().waitFor({ timeout: 30_000 })
await wait(2500)
await shot(owner, '01-owner-conversation')

caption('按標題列的「🔗 分享」，填上名字')
await owner.locator('[data-testid=share-room-share-button]').click()
await wait(800)
await owner.locator('[data-share-room=guest-name]').pressSequentially('小美', { delay: 120 })
await wait(1200)
await shot(owner, '02-create-dialog')
await owner.locator('[data-share-room=create]').click()
const link = owner.locator('[data-share-room=link]')
await link.waitFor({ timeout: 20_000 })
const meiLink = await link.inputValue()
caption('外掛另外 fork 一份分享用的對話，原本的對話維持私人')
await wait(2000)
await shot(owner, '03-invite-link')
await owner.locator('[data-share-room=open-shared]').click()
const manage = owner.locator('[data-testid=share-room-manage-button]')
await manage.waitFor({ timeout: 20_000 })

caption('再邀請阿華。每個人一條連結，只能用一次')
await manage.click(); await wait(600)
await owner.locator('[data-share-room=invite-name]').pressSequentially('阿華', { delay: 120 })
await owner.locator('[data-share-room=invite]').click()
await owner.waitForFunction(() => document.querySelector('[data-testid=share-room-manage]')?.textContent.includes('給「阿華」的連結'), null, { timeout: 10_000 })
const huaLink = await owner.locator('[data-share-room=link]').inputValue()
await wait(1500)
await owner.keyboard.press('Escape')

caption('對方用手機打開連結，不需要帳號，也不用裝 DSH')
await mei.goto(meiLink)
await mei.locator('[data-testid=join]').waitFor({ timeout: 15_000 })
await wait(1200)
await shot(mei, '04-guest-join')
await mei.locator('[data-testid=join]').click()
await mei.locator('[data-testid=log]').waitFor({ timeout: 15_000 })
await hua.goto(huaLink)
await hua.locator('[data-testid=join]').waitFor({ timeout: 15_000 })
await wait(800)
await hua.locator('[data-testid=join]').click()
await hua.locator('[data-testid=log]').waitFor({ timeout: 15_000 })
await manage.filter({ hasText: '2 位訪客' }).waitFor({ timeout: 10_000 })
await wait(1500)
await shot(mei, '05-guest-room')

caption('💬 討論：人跟人聊，AI 不會插嘴')
const say = async (page, text) => { await page.locator('[data-testid=input]').pressSequentially(text, { delay: 60 }); await wait(300); await page.locator('[data-testid=send]').click(); await wait(1400) }
await say(mei, '預算最好壓在兩萬以內')
await say(hua, '我認識一個樂團，可以友情價')
const ownerInput = owner.getByRole('textbox').last()
await ownerInput.pressSequentially('里辦應該可以借一半的帳篷', { delay: 60 }); await wait(300); await ownerInput.press('Enter')
await mei.getByText('里辦應該可以借一半的帳篷').waitFor({ timeout: 10_000 })
await wait(1800)
await shot(owner, '06-owner-discussion')
await shot(hua, '07-guest-discussion')

caption('🤖 問 AI：AI 會讀到剛才的討論再回答，大家都看得到')
await mei.locator('[data-testid=mode]').click(); await wait(500)
await say(mei, '幫我們整理一份預算')
await owner.getByText('附帶 3 則討論').first().waitFor({ timeout: 20_000 })
await mei.locator('.msg.answer').filter({ hasText: '合計' }).last().waitFor({ timeout: 60_000 })
await hua.locator('.msg.answer').filter({ hasText: '合計' }).last().waitFor({ timeout: 10_000 })
await wait(2500)
await shot(owner, '08-owner-ai-answer')
await shot(mei, '09-guest-ai-answer')
await mei.locator('[data-testid=log]').evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {})
await hua.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await wait(1500)

caption('站主也能問 AI，訪客看到的是「小明」')
await owner.locator('[data-share-room=mode]').click(); await wait(500)
await ownerInput.pressSequentially('那分工呢？', { delay: 80 }); await wait(300); await ownerInput.press('Enter')
await hua.locator('.msg.answer').filter({ hasText: '服務台' }).last().waitFor({ timeout: 60_000 })
await hua.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await wait(2500)
await shot(hua, '10-guest-owner-asked')

caption('隨時管理：加邀請、移除訪客、關掉訪客問 AI')
await manage.click(); await wait(2500)
await shot(owner, '11-manage')

caption('結束分享：訪客立刻不能發言，只剩唯讀頁可以下載')
owner.once('dialog', (d) => d.accept())
await owner.locator('[data-share-room=end]').click()
await mei.getByText(/分享已結束/).first().waitFor({ timeout: 10_000 })
await wait(2500)
await shot(mei, '12-guest-ended')
await owner.keyboard.press('Escape')
await wait(1500)
open.end = (Date.now() - t0) / 1000

// Settings screenshot (not in the video).
await owner.getByText(/^(設定|设置|Settings)$/).last().click()
const row = owner.locator('[data-testid=share-room-site-row]')
await row.waitFor({ timeout: 15_000 })
await row.scrollIntoViewIfNeeded()
await owner.evaluate(() => document.querySelector('[data-testid=share-room-site-row]')?.scrollIntoView({ block: 'center' }))
await wait(800)
await shot(owner, '13-settings-switch')

const paths = await Promise.all([owner, mei, hua].map((p) => p.video().path()))
await Promise.all([ownerCtx, meiCtx, huaCtx].map((c) => c.close()))
await browser.close()
for (const [p, n] of paths.map((p, i) => [p, ['owner', 'mei', 'hua'][i]])) renameSync(p, `${OUT}/${n}.webm`)
writeFileSync(`${OUT}/captions.json`, JSON.stringify(captions, null, 1))
console.log('done', ((Date.now() - t0) / 1000).toFixed(1), 's,', captions.length, 'captions')
