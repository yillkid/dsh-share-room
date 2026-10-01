# dsh-share-room

[中文](README.zh-TW.md) | English

> **Status: v0.1 in development.** Works end to end on DSH 0.1.5-rc.1 and 0.1.7-rc.2 in test setups; not yet published. See [PLAN.md](PLAN.md).

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

The guest can ask **your** AI questions, and the AI answers with what it can see. dsh-share-room limits the damage but cannot make the AI keep secrets:

- **The shared conversation runs read-only.** On creation the plugin switches the forked conversation to DSH's `read-only` permission preset (read-only sandbox; anything wider needs your approval). If that fails, no share is created. If you raise the permission later, guests cannot ask the AI until it is read-only again. Your original conversation keeps its own permission.
- **Read-only still reads.** The AI can read files your DSH can read and paste them into an answer. **Anything the AI can see, the guest may get.** Share only with people you trust with that, and run the shared conversation in a workspace that contains only what it needs.
- **Guest text is marked untrusted.** The AI is told who is speaking and that a guest is not the owner, but a model can still be talked into things.
- **Everything is recorded** in the shared conversation, which you can watch live. **You can end the share at any time.** Ending also withdraws guest questions still waiting in the queue; what has already been seen or done cannot be taken back.
- **If you include history**, the guest sees the whole conversation so far, including AI answers.
- The guest pages are served from **the same origin** as your DSH GUI. They use a strict CSP (`script-src 'self'`, no inline script) and render everything as text, but a script-injection bug there would run with your login. For the strongest isolation, serve `/share/` from a separate host name.

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
