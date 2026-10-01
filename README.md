# dsh-share-room

[中文](README.zh-TW.md) | English

> **Status: planning.** Nothing here runs yet. See [PLAN.md](PLAN.md).

Share **one** [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) conversation with someone else, from a button in the session header.

- You pick a conversation and press **🔗 Share**. The plugin forks it into a shared copy and gives you an invite link. Your original conversation stays private.
- Your guest opens the link in any browser. They do **not** need DSH, an account, or your site password.
- The guest sees **only that one conversation**: not your other sessions, files or settings.
- You both talk under your own names. **💬 Discuss** messages are between people; **🤖 Ask AI** sends the prompt, together with the discussion since the last one, to the AI.
- The AI runs on **your** DSH with **your** model key. You pay for every turn, whoever asks.
- You can **end the share at any time**. The guest's link stops working at once, and they can no longer post or ask the AI. They can keep a read-only view or a downloaded copy if you allow it.

## Who is this for

- You want a colleague, client or friend to join a conversation you are already having with your AI, without giving them your whole DSH.
- You run DSH on a host the guest can reach over HTTPS (a public domain or a tunnel).

## What it does not protect against

The guest can ask **your** AI to do things. The AI has whatever access your DSH gives it (files, shell, keys). The share stops the guest from *seeing* your other conversations; it does not stop the AI from *acting* for them. Two things make that manageable:

1. **Everything the guest asks is recorded** in the shared conversation, which you can watch live.
2. **You can end the share at any time.** What the guest has already seen, and what the AI has already done, cannot be taken back.

Share only with people you would let use your AI, and consider running the shared conversation in a workspace that contains only what it needs.

## Install

Not yet published. The plan is:

```bash
# in your DSH web profile
npm install dsh-share-room
# then add "dsh-share-room" to dsh.profile.bundles in the profile's package.json
```

Requires DSH `0.1.5-rc.2` or later. If your DSH sits behind an authentication plugin (for example `dsh-web-auth`), that plugin must let `/share/` through; see [PLAN.md](PLAN.md).

## License

[MIT](LICENSE)
