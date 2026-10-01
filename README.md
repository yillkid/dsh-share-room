# dsh-share-room

[中文](README.zh-TW.md) | English

> **Status: v0.1 in development.** Works end to end on DSH 0.1.7-rc.2 in test containers; not yet published. See [PLAN.md](PLAN.md).

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

Not yet on npm. From a checkout:

```bash
# copy (or npm install from git) into your DSH web profile's node_modules/dsh-share-room
# then add "dsh-share-room" to dsh.profile.bundles in the profile's package.json
```

Tested with DSH `0.1.7-rc.2`. Owner routes live under `/api/share-room.*` and use DSH's own login; guest pages live under `/share/<id>/` and authenticate guests themselves. If your DSH sits behind a login gate for the whole server (for example `@summersec/dsh-web-auth`), that gate must let `/share/` through without opening anything else; see [docs/web-auth-public-prefixes.md](docs/web-auth-public-prefixes.md).

If DSH is reached over HTTPS through a reverse proxy, the guest cookie gets `Secure` automatically when the proxy sends `X-Forwarded-Proto: https`. Set `SHARE_ROOM_SECURE_COOKIE=1` to force it.

## Develop

```bash
node --test test/*.test.js        # unit + server tests (no DSH needed)
node e2e/two-browsers.mjs         # two-browser test against a throwaway DSH, see e2e/README.md
```

## License

[MIT](LICENSE)
