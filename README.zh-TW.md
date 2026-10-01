# dsh-share-room

繁體中文 | [简体中文](README.zh-CN.md) | [English](README.md)

邀請朋友加入你和 AI 的對話。大家用手機或電腦打開連結就能一起討論、一起問 AI，不需要帳號。

這是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的外掛。

![站主在電腦上分享對話，兩位訪客用手機加入、討論、問 AI](docs/media/demo.gif)

完整影片（含字幕）：[docs/media/demo.mp4](docs/media/demo.mp4)

## 它做什麼

- **一鍵分享**：在對話標題列按「🔗 分享」。外掛會另外 fork 一份分享用的對話，原本的對話維持私人。
- **免帳號加入**：每位訪客一條邀請連結，用手機或電腦打開就能加入，只能用一次。不需要安裝 DSH，也不用知道你的站台密碼。
- **多人群聊**：一個分享最多 20 位訪客，每個人都用自己的名字發言。
- **兩種發言**：
  - 💬 **討論**：人跟人聊，AI 不會插嘴。
  - 🤖 **問 AI**：AI 會讀到上次問 AI 之後的討論再回答，大家都看得到答案。
- **只看得到這一段**：訪客看不到你的其他對話、檔案或設定。
- **隨時收回**：你可以移除某位訪客、關掉訪客問 AI，或結束分享。結束後訪客立刻不能發言，可以選擇保留唯讀頁讓對方閱讀和下載。
- **站主開關**：整個功能可以在「設定 → 一般 → 對話分享」關掉。

## 畫面

| 站主（電腦） | 訪客（手機） |
|---|---|
| ![按「🔗 分享」後填名字](docs/media/02-create-dialog.png) | ![打開邀請連結](docs/media/04-guest-join.png) |
| ![討論會顯示在輸入框上方，下次問 AI 時一起交給 AI](docs/media/06-owner-discussion.png) | ![訪客問 AI，答案大家都看得到](docs/media/09-guest-ai-answer.png) |
| ![管理分享：邀請、移除、問 AI 開關、結束](docs/media/11-manage.png) | ![結束後只剩唯讀頁和下載](docs/media/12-guest-ended.png) |

## 使用前要知道的事

訪客可以問**你的** AI，AI 會用它看得到的東西回答。dsh-share-room 會限制影響範圍，但沒辦法讓 AI 保守秘密。

- **費用算你的。** AI 在你的 DSH 上執行，用你的模型金鑰。不管是誰問，費用都由你支付。訪客問 AI 的次數全房共用一個上限，預設 50 次。
- **分享用的對話是唯讀的。** 建立分享時，外掛會把 fork 出來的對話切到 DSH 的 `read-only` 權限，要更多權限得經過你核准；切換失敗就不會建立分享。如果你之後調高權限，訪客會暫時不能問 AI，直到改回唯讀。原本的對話維持原來的權限。
- **唯讀還是讀得到。** AI 可以讀你的 DSH 讀得到的檔案，再寫進回答裡。**AI 看得到的，訪客都可能拿到。** 只分享給你信得過的人，並讓分享的對話跑在只放必要內容的工作區。
- **訪客的文字會標成不可信。** AI 會知道誰在說話、訪客不是擁有者，但模型還是可能被說服。
- **每件事都看得到。** 所有發言和 AI 的動作都記錄在分享的對話裡，你可以即時看到。結束分享時，訪客還在排隊的提問也會一起撤回；但已經看過的內容、AI 已經做完的事，都無法收回。
- **帶入歷史時，訪客看得到整段對話。** 建立分享時勾選「帶入這段對話到目前為止的內容」，訪客就會看到到目前為止的所有內容，包括 AI 的回答。
- **訪客頁和你的 DSH 在同一個網域。** 訪客頁用嚴格的 CSP（`script-src 'self'`，不允許 inline script）。所有內容都當純文字處理，AI 回答的 Markdown 只轉成固定幾種元素，連結和圖片都不啟用。但萬一出現能注入程式的漏洞，程式會帶著你的登入狀態執行。要最強的隔離，請讓 `/share/` 走另一個主機名稱。

## 安裝

需求：DSH `0.1.5-rc.1` 或 `0.1.7-rc.2`（都測試過）、Node.js 22 以上，以及一個對方連得到的 HTTPS 網址（公開網域或 tunnel）。

1. 安裝到 DSH 的 web profile：

   ```bash
   dsh plugin --profile web add dsh-share-room
   ```

   DSH 會用 pnpm 從 npm 安裝，並自動把它加進 profile 的 `dsh.profile.bundles`。

2. 重新啟動 DSH。對話標題列會出現「🔗 分享」。

更新用 `dsh plugin --profile web update dsh-share-room`，移除用 `dsh plugin --profile web remove dsh-share-room`。

不想從 npm 安裝的話，也可以直接用 GitHub 的版本：`dsh plugin --profile web add github:yillkid/dsh-share-room#v0.1.1`。

各部分的位置：

- 擁有者的 API 在 `/api/share-room.*`，沿用 DSH 本身的登入。
- 訪客頁在 `/share/<id>/`，由外掛自己驗證訪客。
- 如果 DSH 前面有整站登入閘門（例如 `@summersec/dsh-web-auth`），閘門必須放行 `/share/`，**而且只放行它**。做法見 [docs/web-auth-public-prefixes.md](docs/web-auth-public-prefixes.md)。
- DSH 經由反向代理以 HTTPS 提供時，只要代理送出 `X-Forwarded-Proto: https`，訪客 cookie 就會自動加上 `Secure`。也可以設定 `SHARE_ROOM_SECURE_COOKIE=1` 強制開啟。

### 開關

裝好預設就是開的。站主可以在「設定 → 一般 → 對話分享」關掉。

- 關閉時不能建立新分享或邀請，所有訪客會立刻看到「分享暫停中」。
- 分享、連結和紀錄都不會刪除，重新開啟後就恢復。

站台範本如果想預設關閉，可以在 `cordis.patch.yml` 裡給 `share-room` 設 `config: { enabled: false }`。站主自己的選擇優先。

## 開發

```bash
node --test test/*.test.js        # 單元與伺服器測試，不需要 DSH
node e2e/two-browsers.mjs         # 兩個瀏覽器的端到端測試，需要拋棄式 DSH，見 e2e/README.md
```

設計與決策紀錄見 [PLAN.md](PLAN.md)，版本紀錄見 [CHANGELOG.md](CHANGELOG.md)。

## 授權

[MIT](LICENSE)
