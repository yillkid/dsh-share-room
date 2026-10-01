# dsh-share-room

[繁體中文](README.zh-TW.md) | 简体中文 | [English](README.md)

邀请朋友加入你和 AI 的对话。大家用手机或电脑打开链接就能一起讨论、一起问 AI，不需要账号。

这是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的插件。

![站主在电脑上分享对话，两位访客用手机加入、讨论、问 AI](docs/media/demo.gif)

完整视频（含字幕）：[docs/media/demo.mp4](docs/media/demo.mp4)・讨论与反馈：[DSH Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions/8564)

> 界面文字目前是繁体中文。

## 它做什么

- **一键分享**：在对话标题栏点「🔗 分享」。插件会另外 fork 一份分享用的对话，原来的对话保持私密。
- **免账号加入**：每位访客一条邀请链接，用手机或电脑打开就能加入，只能用一次。不需要安装 DSH，也不用知道你的站点密码。
- **多人群聊**：一个分享最多 20 位访客，每个人都用自己的名字发言。
- **两种发言**：
  - 💬 **讨论**：人跟人聊，AI 不会插话。
  - 🤖 **问 AI**：AI 会读到上次问 AI 之后的讨论再回答，大家都看得到答案。
- **只看得到这一段**：访客看不到你的其他对话、文件或设置。
- **随时收回**：你可以移除某位访客、关掉访客问 AI，或结束分享。结束后访客立刻不能发言，可以选择保留只读页让对方阅读和下载。
- **站主开关**：整个功能可以在「设置 → 通用设置 → 對話分享」关掉。

## 界面

| 站主（电脑） | 访客（手机） |
|---|---|
| ![点「🔗 分享」后填名字](docs/media/02-create-dialog.png) | ![打开邀请链接](docs/media/04-guest-join.png) |
| ![讨论显示在输入框上方，下次问 AI 时一起交给 AI](docs/media/06-owner-discussion.png) | ![访客问 AI，答案大家都看得到](docs/media/09-guest-ai-answer.png) |
| ![管理分享：邀请、移除、问 AI 开关、结束](docs/media/11-manage.png) | ![结束后只剩只读页和下载](docs/media/12-guest-ended.png) |

## 使用前要知道的事

访客可以问**你的** AI，AI 会用它看得到的东西回答。dsh-share-room 会限制影响范围，但没办法让 AI 保守秘密。

- **费用算你的。** AI 在你的 DSH 上运行，用你的模型密钥。不管是谁问，费用都由你支付。访客问 AI 的次数全房共用一个上限，默认 50 次。
- **分享用的对话是只读的。** 创建分享时，插件会把 fork 出来的对话切换到 DSH 的 `read-only` 权限，要更多权限得经过你批准；切换失败就不会创建分享。如果你之后调高权限，访客会暂时不能问 AI，直到改回只读。原来的对话保持原来的权限。
- **只读还是读得到。** AI 可以读取你的 DSH 读得到的文件，再写进回答里。**AI 看得到的，访客都可能拿到。** 只分享给你信得过的人，并让分享的对话运行在只放必要内容的工作区。
- **访客的文字会标记为不可信。** AI 会知道谁在说话、访客不是所有者，但模型还是可能被说服。
- **每件事都看得到。** 所有发言和 AI 的操作都记录在分享的对话里，你可以实时看到。结束分享时，访客还在排队的提问也会一起撤回；但已经看过的内容、AI 已经做完的事，都无法收回。
- **带入历史时，访客看得到整段对话。** 创建分享时勾选「帶入這段對話到目前為止的內容」，访客就会看到到目前为止的所有内容，包括 AI 的回答。
- **访客页和你的 DSH 在同一个域名。** 访客页使用严格的 CSP（`script-src 'self'`，不允许 inline script）。所有内容都按纯文本处理，AI 回答的 Markdown 只转换成固定几种元素，链接和图片都不启用。但万一出现能注入代码的漏洞，代码会带着你的登录状态运行。要最强的隔离，请让 `/share/` 走另一个主机名。

## 安装

要求：DSH `0.1.5-rc.1` 或 `0.1.7-rc.2`（都测试过）、Node.js 22 以上，以及一个对方访问得到的 HTTPS 地址（公开域名或 tunnel）。

1. 安装到 DSH 的 web profile：

   ```bash
   dsh plugin --profile web add dsh-share-room
   ```

   DSH 会用 pnpm 从 npm 安装，并自动把它加进 profile 的 `dsh.profile.bundles`。

2. 重启 DSH。对话标题栏会出现「🔗 分享」。

更新用 `dsh plugin --profile web update dsh-share-room`，卸载用 `dsh plugin --profile web remove dsh-share-room`。

不想从 npm 安装的话，也可以直接用 GitHub 的版本：`dsh plugin --profile web add github:yillkid/dsh-share-room#v0.1.1`。

各部分的位置：

- 所有者的 API 在 `/api/share-room.*`，沿用 DSH 本身的登录。
- 访客页在 `/share/<id>/`，由插件自己验证访客。
- 如果 DSH 前面有全站登录闸门（例如 `@summersec/dsh-web-auth`），闸门必须放行 `/share/`，**而且只放行它**。做法见 [docs/web-auth-public-prefixes.md](docs/web-auth-public-prefixes.md)。
- DSH 经由反向代理以 HTTPS 提供时，只要代理发送 `X-Forwarded-Proto: https`，访客 cookie 就会自动加上 `Secure`。也可以设置 `SHARE_ROOM_SECURE_COOKIE=1` 强制开启。

### 开关

装好默认就是开的。站主可以在「设置 → 通用设置 → 對話分享」关掉。

- 关闭时不能创建新分享或邀请，所有访客会立刻看到「分享暫停中」。
- 分享、链接和记录都不会删除，重新开启后就恢复。

站点模板如果想默认关闭，可以在 `cordis.patch.yml` 里给 `share-room` 设置 `config: { enabled: false }`。站主自己的选择优先。

## 开发

```bash
node --test test/*.test.js        # 单元与服务器测试，不需要 DSH
node e2e/two-browsers.mjs         # 两个浏览器的端到端测试，需要一次性 DSH，见 e2e/README.md
```

设计与决策记录见 [PLAN.md](PLAN.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
