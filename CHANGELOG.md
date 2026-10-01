# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/); while the version is `0.x`, minor versions may change behavior.

## 0.1.0 — 2026-10-01

First release. Tested on DSH `0.1.5-rc.1` and `0.1.7-rc.2`.

### Sharing
- **🔗 Share** in the session header. It forks a separate shared conversation and leaves the original private. History can optionally be brought in.
- Single-use invite links, one per guest, with up to 20 guests per share. Guests need no DSH account. Reissuing a link for the same name revokes the old unused one.
- 💬 **Discuss** goes between people and never reaches the AI. 🤖 **Ask AI** sends the question, with the discussion since the last one, to the AI. Every message is tagged with its speaker.
- The owner can remove guests, turn guest questions on or off, set a shared guest-question limit (50 by default), and end the share. After it ends, guests keep an optional read-only page and a Markdown download.
- Site switch under Settings → General → 對話分享 (on by default). Turning it off pauses every guest at once and deletes nothing. Templates can default it off with `config: { enabled: false }`.

### Guest page
- A plain-DOM page served under a strict CSP (`script-src 'self'`). It never builds HTML from strings.
- AI answers render Markdown (headings, emphasis, lists, tables, code, quotes) into a fixed set of elements. Links and images stay as text.
- Works on phones.

### Security
- The shared conversation runs with DSH's `read-only` permission. If switching fails, no share is created, and guest questions pause if the permission is raised later.
- Guest text is marked untrusted for the AI. Reserved tag names inside people's text are neutralized.
- Only whitelisted event types are shown to guests. Tool output, system prompts and runtime context are never shown.
- The join rate limit counts failures only and is keyed per share. Each guest is limited to 4 event streams.
- Ending a share withdraws guest questions still in the queue.
- A patch for `@summersec/dsh-web-auth` (`publicPrefixes`) opens only `/share/`. Encoded and `../` bypasses are rejected.
