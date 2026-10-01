// Scripted OpenAI-compatible model for demo screenshots and video.
// Replies are picked by keywords in the person's own words (the share-room tag
// part is ignored), streamed in small pieces so a recording looks natural.
import http from 'node:http'
const port = Number(process.env.PORT ?? 18990)
const DELAY = Number(process.env.DEMO_DELAY_MS ?? 35)

const SCRIPT = [
  [/週末|活動|企劃|市集/, `好的！先整理一個週末市集活動的草案：

- **主題**：「街角小市集」— 在地小農與手作攤位
- **時間**：週六 10:00–16:00
- **場地**：社區活動中心前廣場

**三個重點**
1. 攤位：預計 12 攤，小農 6、手作 4、餐飲 2
2. 活動：上午親子手作課、下午街頭音樂
3. 宣傳：提前兩週在社群與里民群組公告

接下來可以決定預算和人力分工。`],
  [/預算|經費|多少錢/, `根據剛才的討論，我把大家的意見整理成一份預算：

| 項目 | 金額 | 備註 |
|---|---|---|
| 帳篷與桌椅租借 | 8,000 | 小美提到可以向里辦借一半 |
| 音響與表演車馬費 | 6,000 | 阿華說樂團可以友情價 |
| 宣傳海報與印刷 | 2,500 | |
| 保險與雜支 | 3,500 | |
| **合計** | **20,000** | |

小美和阿華都偏好壓在兩萬以內，這個版本剛好符合。如果里辦能借到帳篷，可以再省 4,000。`],
  [/分工|誰負責|人力/, `建議的分工如下：

- **小明**：場地申請、和里辦聯繫
- **小美**：攤商招募與排位
- **阿華**：表演節目與音響
- **大家**：活動當天輪班顧服務台，每人兩小時

要我把這份分工整理成一張可以列印的表格嗎？`],
]

const textOf = (m) => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p) => p.text ?? '').join('\n')
// Only the person's words: drop the plugin's trailing tag part.
const ownWords = (m) => textOf(m).split('<share_room_')[0]

function reply(msgs) {
  // DSH may append its own runtime-context user message; skip those.
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && !/runtime context|<system-reminder>/i.test(textOf(m).slice(0, 200)))
  const said = ownWords(lastUser)
  for (const [re, text] of SCRIPT) if (re.test(said)) return text
  return `收到。${said.trim().slice(0, 60)}——我會根據目前的討論繼續協助大家。`
}

http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'demo', object: 'model' }] })) }
  const j = JSON.parse(body)
  const id = 'c' + Date.now()
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: j.model }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
  const text = reply(j.messages ?? [])
  for (const part of text.match(/[\s\S]{1,6}/g) ?? ['']) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: part }, finish_reason: null }] })
    await new Promise((r) => setTimeout(r, DELAY))
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } })
  res.end('data: [DONE]\n\n')
}).listen(port, '0.0.0.0', () => console.log('demo-llm on', port))
