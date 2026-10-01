# dsh-share-room

中文 | [English](README.md)

> **狀態：v0.1 開發中。** 已在 DSH 0.1.7-rc.2 的測試容器完整跑通，尚未發布。請看 [PLAN.md](PLAN.md)。

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

對方可以叫**你的** AI 做事，而 AI 擁有你的 DSH 給它的權限（檔案、shell、金鑰）。分享擋住的是對方「看到」你的其他對話，擋不住 AI「替對方做事」。有兩件事讓這個風險可控：

1. **對方叫 AI 做的每件事都記錄在**分享的對話裡，你可以即時看到。
2. **你可以隨時結束分享。** 但對方已經看過的內容、AI 已經做完的事，無法收回。

只分享給你願意讓他使用你 AI 的人，並考慮讓分享的對話跑在只放必要內容的工作區。

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
