# dsh-share-room

中文 | [English](README.md)

> **狀態：v0.1 開發中。** 已在 DSH 0.1.5-rc.1 與 0.1.7-rc.2 的測試環境完整跑通，尚未發布。請看 [PLAN.md](PLAN.md)。

在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的對話標題列按一下，就能把**單一**對話分享給別人一起討論。

- 選一個對話，按「🔗 分享」。外掛會 fork 出一份分享用的對話，並給你一個邀請連結；原本的對話維持私人。
- 對方用任何瀏覽器打開連結就能加入。**不需要**安裝 DSH、不需要帳號，也不需要你的站台密碼。
- 對方**只看得到這一個對話**，看不到你的其他對話、檔案或設定。
- 兩人都用自己的名字發言。**💬 討論**是人跟人之間的對話；**🤖 問 AI** 會把這句話，連同上次問 AI 之後的討論，一起交給 AI。
- AI 在**你的** DSH 上執行，用**你的**模型金鑰。不管是誰問 AI，費用都算你的。
- 你可以**隨時結束分享**。對方的連結立刻失效，不能再發言，也叫不了 AI。你可以選擇讓對方保留唯讀頁或下載副本。

## 適合誰

- 你想讓同事、客戶或朋友加入你正在和 AI 進行的對話，但不想把整個 DSH 交給他。
- 你的 DSH 在對方連得到的 HTTPS 位址上（公開網域或 tunnel）。

## 擋不住的事

對方可以問**你的** AI，AI 會用它看得到的東西回答。dsh-share-room 會限制影響範圍，但沒辦法讓 AI 保守秘密：

- **分享用的對話是唯讀的。** 建立分享時，外掛會把 fork 出來的對話切到 DSH 的 `read-only` 權限（唯讀沙箱，要更多權限得經過你核准）。切換失敗就不會建立分享。如果你之後調高權限，訪客會暫時不能問 AI，直到改回唯讀。原本的對話維持原來的權限。
- **唯讀還是讀得到。** AI 可以讀你的 DSH 讀得到的檔案，再貼進回答裡。**AI 看得到的，訪客都可能拿到。** 只分享給你信得過的人，並讓分享的對話跑在只放必要內容的工作區。
- **訪客的文字會標成不可信。** AI 會知道是誰在說話、訪客不是擁有者，但模型還是可能被說服。
- **每件事都記錄在**分享的對話裡，你可以即時看到。**你可以隨時結束分享**，結束時也會撤回訪客還在排隊的提問；已經看過的內容、AI 已經做完的事，無法收回。
- **如果帶入歷史**，訪客會看到到目前為止的整段對話，包括 AI 的回答。
- 訪客頁和你的 DSH 介面在**同一個網域**。訪客頁用嚴格的 CSP（`script-src 'self'`，不允許 inline script），所有內容都當純文字顯示；但如果那裡出現能注入程式的漏洞，程式會帶著你的登入狀態執行。要最強的隔離，請讓 `/share/` 走另一個主機名稱。

## 安裝

還沒上 npm。從原始碼：

```bash
# 複製（或從 git npm install）到 DSH web profile 的 node_modules/dsh-share-room
# 再把 "dsh-share-room" 加進 profile package.json 的 dsh.profile.bundles
```

已在 DSH `0.1.7-rc.2` 測試。擁有者的 API 在 `/api/share-room.*`，用 DSH 本身的登入；訪客頁面在 `/share/<id>/`，由外掛自己驗證訪客。如果你的 DSH 前面有整站登入閘門（例如 `@summersec/dsh-web-auth`），閘門必須放行 `/share/`、而且只放行它，請看 [docs/web-auth-public-prefixes.md](docs/web-auth-public-prefixes.md)。

如果 DSH 經由反向代理以 HTTPS 提供，代理送出 `X-Forwarded-Proto: https` 時，訪客 cookie 會自動加上 `Secure`。也可以設 `SHARE_ROOM_SECURE_COOKIE=1` 強制開啟。

## 開發

```bash
node --test test/*.test.js        # 單元與伺服器測試（不需要 DSH）
node e2e/two-browsers.mjs         # 兩個瀏覽器的端到端測試，需要拋棄式 DSH，見 e2e/README.md
```

## 授權

[MIT](LICENSE)
