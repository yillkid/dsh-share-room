# End-to-end check

`two-browsers.mjs` drives an owner browser (logged in to DSH) and a guest browser
(no DSH login, mobile viewport) through the whole flow: share → join → 💬 → 🤖 →
AI switch → end → read-only → delete.

It needs a **throwaway** DSH with:

- `dsh-share-room` installed as a profile bundle;
- the guest prefix public in your auth gate (for `@summersec/dsh-web-auth`:
  `publicPrefixes: ['/share']`, see `docs/web-auth-public-prefixes.md`);
- a deterministic fake OpenAI-compatible model that replies `ECHO[<last user text>]`,
  and turns `RUN: <cmd>` into one `bash` tool call followed by `工具結果長度 N`.

```sh
SHARE_ROOM_BASE=http://localhost:18997 \
SHARE_ROOM_PASSWORD=<throwaway password> \
PLAYWRIGHT_FROM=/path/to/node_modules/ \
node e2e/two-browsers.mjs
```

Never point it at a real DSH: it creates sessions and runs a shell command.
