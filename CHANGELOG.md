# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/); while the version is `0.x`, minor versions may change behavior.

## 0.3.2 — 2026-10-29

### Compatibility
- **Works on DSH 0.2.1** (tested with 0.2.1-rc.5, Node 24) as well as 0.1.7. DSH 0.2 answers `session/projections` for a conversation written by an older DSH and not yet migrated with `kind: "migration-required"` and no `asOfSeq`, so its history could not be read. share-room now reads the opening snapshot of `session/follow` instead, which activates (and so migrates) the conversation and carries a sequenced baseline; `kind: "sequenced"` and 0.1.7 answers are used as before.
- New test `test/dsh02-load.test.mjs` (run with `npm run test:dsh02`): loads share-room in the real cordis of DSH 0.2.1-rc.5 and checks it starts, registers its routes, is **first** in the `user-questions/request` waterfall ahead of a listener registered earlier (it fails if `prepend` is dropped), passes an unshared session through, and disposes cleanly. `npm test` stays offline.
- `shares.json` stays format 1. A copy of a live site booted on DSH 0.2.1-rc.5 kept every share, with no plugin skipped.

## 0.3.1 — 2026-10-27

### Fixed
- **The AI's questions did not reach the room on a real DSH site.** In a Cordis waterfall the first listener owns `next()`; DSH's own Web answerer loads first and settles only when the owner answers, so the share-room listener registered after it never ran. It now registers with `prepend` and calls the owner page as `next()` in parallel, so both see the question and the first answer wins. Found by the end-to-end check on a live site; the server tests now model this listener order and fail without the fix.
- **Switching a share to full access while the AI waited dropped the question.** DSH emits the new preset before share-room records it as the share's setting; judged in between it looked like the owner had raised the permission above the share, so guests were paused and the waiting question withdrawn. The owner's own switch is now recognised. The test mock emits the preset event the way DSH does.

## 0.3.0 — 2026-10-27

### Added
- **The AI's questions reach the room.** When the AI asks a choice (`ask_user_question`) or presents a plan for review (plan mode), the question is also shown in the shared room. In a **full-access** share, any guest may answer or approve the plan; the first answer wins (the owner's own DSH page included) and the room records who answered. In a **read-only** or **workspace-write** share, guests see the question and that the AI is waiting, but only the owner answers. Nothing here changes what the AI may do: permission approvals stay with the owner.
- **Archiving the shared conversation pauses the share.** DSH does not run an archived conversation, so guests are now told 「分享者已封存這個對話」 and cannot post or ask until it is unarchived; the share is paused, not ended. Archiving the original (unshared) conversation does not affect the share.
- **The shared copy's title shows its state** in the sidebar: 「🔗 名稱（分享中・N 位）」, 「（已封存・暫停）」, 「（已結束）」, so it is no longer confused with the original conversation of the same name.
- **Raising the permission from the composer is explained.** When the shared conversation runs wider than the share's setting, guests see why they cannot ask the AI, and the owner sees a notice of how many guests are paused. A full-access share shows a standing warning to the owner.

### Compatibility
- `shares.json` stays format 1. Shares created by 0.1.x (no permission recorded) still read as read-only. A compatibility test loads an anonymized live `shares.json` and checks every share keeps its state, guests and AI budget, and that nothing becomes wider.

## 0.2.0 — 2026-10-05

### Added
- **AI permission per share.** The manage dialog has an 「AI 的權限」 picker: read-only (default), `workspace-write`, or full access (`danger-full-access`). The choice is applied to the shared session and enforced on every guest question. A session running wider than the chosen preset pauses guest questions, as before.
- **Full access needs a site switch.** 「分享可使用完全權限」 under Settings → General is off by default. Picking full access also needs a confirmation. Turning the switch off moves live full-access shares back to read-only, and guest questions stay refused if that fails. Every change is audited.
- **Extend or shorten a live share.** Set how many more days it stays open, up to 90 days from creation. Unused invites never outlive the share. Ended shares can't be reopened.
- **Change the guest-question limit later.** Raise or lower it, but not below the questions already asked.

### Changed
- Guest cookies now last until the latest date the share could be extended to (plus read-only days), and `/state` refreshes cookies issued by 0.1.x. Access is still decided by the server on every request.
- `/api/share-room.site` also reports `fullAccess`. Shares created before 0.2.0 count as read-only.

## 0.1.1 — 2026-10-01

First npm release. No code changes since 0.1.0.

- Install with `dsh plugin --profile web add dsh-share-room`.
- README: the opening now leads with inviting people into your AI conversation.

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
