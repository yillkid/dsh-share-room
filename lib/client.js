// dsh-share-room Web client (owner side). Hand-written module, no build step.
//  - "🔗 分享" in the session header: fork → create share → invite link dialog.
//  - In a shared session: "分享中 · N 位訪客" menu (copy new link, remove guest,
//    AI on/off, end share, delete read-only page), a 💬/🤖 toggle in the input,
//    the 💬 discussion dock, and speaker badges on tagged user messages.
window.__ModuleLoader__.load({
	id: "dsh-share-room",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

		const SPEAKER_OPEN = "<share_room_speaker>";
		const SPEAKER_CLOSE = "</share_room_speaker>";
		const DISCUSSION_OPEN = "<share_room_discussion>";
		const DISCUSSION_CLOSE = "</share_room_discussion>";
		const OWN = Symbol("dsh-share-room");

		// Mirror of lib/core.js cleanName/validSpeaker/parseTagged (kept in sync by test/client.test.js).
		const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
		function cleanName(name) {
			if (typeof name !== "string") return undefined;
			const value = name.replace(CONTROL, "").replace(/\s+/g, " ").trim();
			if (value === "" || [...value].length > 40) return undefined;
			return value;
		}
		function validSpeaker(value) {
			return value !== null && typeof value === "object" && typeof value.id === "string" && value.id.length <= 64 &&
				typeof value.name === "string" && cleanName(value.name) === value.name &&
				(value.role === "owner" || value.role === "guest");
		}
		function parseTagged(text) {
			if (typeof text !== "string" || !text.startsWith(SPEAKER_OPEN)) return undefined;
			const end = text.indexOf(SPEAKER_CLOSE);
			if (end < 0) return undefined;
			let speaker;
			try { speaker = JSON.parse(text.slice(SPEAKER_OPEN.length, end)); } catch { return undefined; }
			if (!validSpeaker(speaker)) return undefined;
			let rest = text.slice(end + SPEAKER_CLOSE.length).replace(/^\n/, "");
			let discussion = [];
			if (rest.startsWith(DISCUSSION_OPEN)) {
				const close = rest.indexOf(DISCUSSION_CLOSE);
				if (close >= 0) {
					discussion = rest.slice(DISCUSSION_OPEN.length, close).split("\n").filter(Boolean).flatMap((line) => {
						try { const row = JSON.parse(line); return typeof row.text === "string" && typeof row.name === "string" ? [{ name: row.name, text: row.text }] : []; } catch { return []; }
					});
				}
			}
			return { speaker: { id: speaker.id, name: speaker.name, role: speaker.role }, discussion };
		}
		function splitTagged(content) {
			if (!Array.isArray(content)) return undefined;
			for (let i = content.length - 1; i >= 0; i--) {
				const part = content[i];
				if (part === null || typeof part !== "object" || part.type !== "text") continue;
				const parsed = parseTagged(part.text);
				if (parsed === undefined) return undefined;
				return { ...parsed, content: [...content.slice(0, i), ...content.slice(i + 1)] };
			}
			return undefined;
		}

		// ------------------------------------------------------------------
		// Stores

		function createStore(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				get: () => value,
				set: (next) => { value = typeof next === "function" ? next(value) : next; for (const fn of [...listeners]) fn(); },
				subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
			};
		}
		const useStore = (store) => React.useSyncExternalStore(store.subscribe, store.get, store.get);

		async function api(path, body) {
			const res = await fetch(`/api/share-room.${path}`, body === undefined
				? { credentials: "same-origin", cache: "no-store" }
				: { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			let data = null;
			try { data = await res.json(); } catch {}
			if (!res.ok) throw new Error(data?.message || `操作失敗（${res.status}）`);
			return data;
		}

		// Site switch (settings → general). undefined until first loaded.
		const site = createStore({ enabled: undefined });
		let siteLoading;
		function loadSite() {
			siteLoading ??= api("site").then((r) => site.set(() => ({ enabled: r.enabled !== false })), () => { siteLoading = undefined; });
			return siteLoading;
		}
		const useSite = () => { React.useEffect(() => { loadSite(); }, []); return useStore(site); };

		// Per-session live state from /api/share-room.events.
		const rooms = new Map();
		function roomOf(sessionId) {
			let room = rooms.get(sessionId);
			if (room) return room;
			room = { store: createStore({ loaded: false, share: null, messages: [], upTo: 0, connected: false }), source: undefined, refs: 0, timer: undefined };
			rooms.set(sessionId, room);
			return room;
		}
		function retainRoom(sessionId) {
			const room = roomOf(sessionId);
			room.refs++;
			clearTimeout(room.timer);
			if (!room.source) {
				const source = new EventSource(`/api/share-room.events?sessionId=${encodeURIComponent(sessionId)}`);
				room.source = source;
				source.onopen = () => room.store.set((s) => ({ ...s, connected: true }));
				source.onerror = () => room.store.set((s) => ({ ...s, connected: false }));
				source.onmessage = (event) => {
					let data;
					try { data = JSON.parse(event.data); } catch { return; }
					if (data.type === "site" || (data.type === "snapshot" && typeof data.enabled === "boolean")) site.set(() => ({ enabled: data.enabled }));
					if (data.type === "snapshot") room.store.set((s) => ({ ...s, loaded: true, connected: true, share: data.share, messages: data.discussion?.messages ?? [], upTo: data.discussion?.upTo ?? 0 }));
					else if (data.type === "share") room.store.set((s) => ({ ...s, share: data.share }));
					else if (data.type === "discussion") room.store.set((s) => s.messages.some((m) => m.seq === data.message.seq) ? s : ({ ...s, messages: [...s.messages, data.message].slice(-500) }));
					else if (data.type === "bundled") room.store.set((s) => ({ ...s, upTo: Math.max(s.upTo, data.upTo) }));
				};
			}
			return () => {
				room.refs--;
				if (room.refs > 0) return;
				room.timer = setTimeout(() => {
					if (room.refs > 0) return;
					room.source?.close();
					room.source = undefined;
					rooms.delete(sessionId);
				}, 5000);
			};
		}
		const useRoom = (sessionId) => {
			const room = roomOf(sessionId);
			React.useEffect(() => retainRoom(sessionId), [sessionId]);
			return useStore(room.store);
		};
		const isLive = (share) => share && share.access === "active";

		const modes = new Map();
		const modeOf = (sessionId) => {
			let store = modes.get(sessionId);
			if (!store) modes.set(sessionId, store = createStore("discuss"));
			return store;
		};

		// ------------------------------------------------------------------
		// Styles

		const btn = (extra = {}) => ({
			display: "inline-flex", alignItems: "center", gap: 4, height: 26, padding: "0 8px", borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2, #d0d0d0)", background: "transparent", color: "inherit",
			cursor: "pointer", fontSize: 13, lineHeight: "24px", whiteSpace: "nowrap", ...extra,
		});
		// The theme's own fill/foreground pair: in dark mode the fill is light and
		// the text dark, so a fixed white label would vanish.
		const primary = { ...btn(), background: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))", color: "var(--dsw-alias-label-primary-foreground, #fff)", border: "1px solid transparent", height: 32, padding: "0 14px", fontWeight: 600 };
		const field = { width: "100%", boxSizing: "border-box", height: 32, padding: "0 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #ccc)", background: "var(--dsw-alias-bg-layer-1, #fff)", color: "inherit", fontSize: 14 };
		const label = { display: "block", fontSize: 13, margin: "10px 0 4px", opacity: 0.85 };

		function Overlay({ onClose, children, testid }) {
			React.useEffect(() => {
				const onKey = (e) => { if (e.key === "Escape") onClose(); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			return jsx("div", {
				style: { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center" },
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
				children: jsx("div", {
					role: "dialog", "aria-modal": "true", "data-testid": testid,
					style: { width: "min(440px, calc(100vw - 32px))", maxHeight: "calc(100vh - 48px)", overflowY: "auto", borderRadius: 12, padding: 20, background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-primary, #111)", boxShadow: "0 12px 40px rgba(0,0,0,.25)", fontSize: 14, lineHeight: 1.5 },
					children,
				}),
			});
		}

		function LinkBox({ path }) {
			const url = `${window.location.origin}${path}`;
			const [copied, setCopied] = React.useState(false);
			const copy = async () => {
				try { await navigator.clipboard.writeText(url); setCopied(true); }
				catch { const el = document.querySelector("[data-share-room=link]"); el?.select?.(); }
			};
			return jsxs("div", {
				children: [
					jsxs("div", { style: { display: "flex", gap: 6, marginTop: 6 }, children: [
						jsx("input", { readOnly: true, value: url, "data-share-room": "link", style: { ...field, fontSize: 12 }, onFocus: (e) => e.target.select() }),
						jsx("button", { type: "button", style: btn({ height: 32 }), "data-share-room": "copy", onClick: copy, children: copied ? "已複製" : "複製" }),
					] }),
					jsx("p", { style: { fontSize: 12, opacity: 0.7, margin: "6px 0 0" }, children: "連結只能使用一次，也只會顯示這一次。不會出現在對話內容裡。" }),
				],
			});
		}

		// ------------------------------------------------------------------
		// Create dialog

		function CreateDialog({ ctx, sessionId, ownerName, onClose }) {
			const [form, setForm] = React.useState({ ownerName: ownerName ?? "", guestName: "", history: true, aiAllowed: true, aiBudget: 50, ttlDays: 7, readOnly: true });
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [done, setDone] = React.useState(null);
			const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
			const submit = async (e) => {
				e.preventDefault();
				setBusy(true); setError("");
				try {
					// Without history: fork at seq 0 keeps the workspace/cwd but no messages.
					const childId = await ctx.sessions.fork(form.history ? { sessionId } : { sessionId, atSeq: 0 });
					const result = await api("create", {
						sessionId: childId, sourceSessionId: sessionId, ownerName: form.ownerName, guestName: form.guestName,
						aiAllowed: form.aiAllowed, aiBudget: Number(form.aiBudget), ttlDays: Number(form.ttlDays), readOnlyDays: form.readOnly ? 30 : 0,
					});
					setDone({ childId, invitePath: result.invitePath, guestName: form.guestName });
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally { setBusy(false); }
			};
			const finish = () => {
				if (done) { try { ctx.uiWorkspace.openSession(done.childId); } catch {} }
				onClose();
			};
			if (done) {
				return jsx(Overlay, { onClose: finish, testid: "share-room-created", children: jsxs(Fragment, { children: [
					jsx("h2", { style: { fontSize: 17, margin: "0 0 6px" }, children: "分享已建立" }),
					jsx("p", { style: { margin: 0 }, children: `把這個連結傳給「${done.guestName}」：` }),
					jsx(LinkBox, { path: done.invitePath }),
					jsx("p", { style: { fontSize: 13, opacity: 0.8 }, children: "分享的是一份新的對話副本；你原本的對話不受影響。接下來會切換到分享中的對話。" }),
					jsx("div", { style: { textAlign: "right", marginTop: 12 }, children: jsx("button", { type: "button", style: primary, "data-share-room": "open-shared", onClick: finish, children: "前往分享中的對話" }) }),
				] }) });
			}
			return jsx(Overlay, { onClose, testid: "share-room-create", children: jsxs("form", { onSubmit: submit, children: [
				jsx("h2", { style: { fontSize: 17, margin: "0 0 4px" }, children: "分享這個對話" }),
				jsx("p", { style: { fontSize: 13, opacity: 0.8, margin: 0 }, children: "會另外建立一份分享用的對話。對方只看得到那一份，看不到你的其他對話。" }),
				jsx("label", { style: label, children: "你的名字（對方會看到）" }),
				jsx("input", { required: true, maxLength: 40, value: form.ownerName, onChange: set("ownerName"), style: field, "data-share-room": "owner-name" }),
				jsx("label", { style: label, children: "訪客名字" }),
				jsx("input", { required: true, maxLength: 40, value: form.guestName, onChange: set("guestName"), style: field, placeholder: "例如：千佳", "data-share-room": "guest-name", autoFocus: true }),
				jsxs("label", { style: { ...label, display: "flex", gap: 6, alignItems: "flex-start" }, children: [
					jsx("input", { type: "checkbox", checked: form.history, onChange: set("history"), "data-share-room": "history" }),
					jsxs("span", { children: ["帶入這段對話到目前為止的內容", form.history && jsx("span", { style: { display: "block", fontSize: 12, color: "#b45309" }, children: "對方會看到目前為止的全部內容（包括 AI 的回答）。" })] }),
				] }),
				jsxs("label", { style: { ...label, display: "flex", gap: 6, alignItems: "center" }, children: [
					jsx("input", { type: "checkbox", checked: form.aiAllowed, onChange: set("aiAllowed"), "data-share-room": "ai-allowed" }),
					"允許對方問 AI，最多",
					jsx("input", { type: "number", min: 0, max: 10000, value: form.aiBudget, onChange: set("aiBudget"), disabled: !form.aiAllowed, style: { ...field, width: 72, height: 26 } }),
					"次",
				] }),
				jsx("p", { style: { fontSize: 12, opacity: 0.75, margin: "2px 0 0 22px" }, children: "AI 用你的模型金鑰和你的權限執行，費用算你的。對方叫 AI 做的每件事都會記錄在對話裡。" }),
				jsxs("label", { style: { ...label, display: "flex", gap: 6, alignItems: "center" }, children: [
					"連結有效",
					jsx("input", { type: "number", min: 1, max: 90, value: form.ttlDays, onChange: set("ttlDays"), style: { ...field, width: 64, height: 26 } }),
					"天",
				] }),
				jsxs("label", { style: { ...label, display: "flex", gap: 6, alignItems: "center" }, children: [
					jsx("input", { type: "checkbox", checked: form.readOnly, onChange: set("readOnly") }),
					"結束後保留唯讀頁 30 天（對方可以繼續閱讀和下載）",
				] }),
				jsx("p", { style: { fontSize: 12, color: "#6b7280", margin: "10px 0 0" }, "data-share-room": "read-only-note", children: "分享用的對話會設成唯讀權限。訪客問 AI 時，AI 用你的帳號、讀得到你的檔案；AI 看得到的內容，訪客都可能拿到。" }),
				error && jsx("p", { role: "alert", style: { color: "#dc2626", fontSize: 13 }, children: error }),
				jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }, children: [
					jsx("button", { type: "button", style: btn({ height: 32 }), onClick: onClose, children: "取消" }),
					jsx("button", { type: "submit", style: primary, disabled: busy, "data-share-room": "create", children: busy ? "建立中…" : "建立分享" }),
				] }),
			] }) });
		}

		// ------------------------------------------------------------------
		// Manage dialog (inside a shared session)

		function ManageDialog({ share, onClose }) {
			const [invite, setInvite] = React.useState(null);
			const [guestName, setGuestName] = React.useState("");
			const [error, setError] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const run = async (fn) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
			const [aiPending, setAiPending] = React.useState(undefined);
			React.useEffect(() => setAiPending(undefined), [share.aiAllowed]);
			const live = isLive(share);
			const guests = share.guests.filter((g) => !g.removedAt);
			return jsx(Overlay, { onClose, testid: "share-room-manage", children: jsxs(Fragment, { children: [
				jsx("h2", { style: { fontSize: 17, margin: "0 0 4px" }, children: live ? "分享中" : share.access === "readonly" ? "分享已結束（唯讀頁保留中）" : "分享已結束" }),
				jsx("p", { style: { fontSize: 13, opacity: 0.8, margin: 0 }, children: live
					? `到期：${new Date(share.expiresAt).toLocaleString()}`
					: `結束於：${new Date(share.endedAt ?? share.expiresAt).toLocaleString()}` }),
				jsx("h3", { style: { fontSize: 14, margin: "14px 0 4px" }, children: "訪客" }),
				guests.length === 0 && jsx("p", { style: { fontSize: 13, opacity: 0.7, margin: 0 }, children: "還沒有人加入。" }),
				guests.map((g) => jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }, children: [
					jsx("span", { children: g.name }),
					jsx("button", { type: "button", style: btn(), disabled: busy, "data-share-room": "remove-guest", onClick: () => run(() => api("remove-guest", { shareId: share.id, guestId: g.guestId })), children: "移除" }),
				] }, g.guestId)),
				share.invites.length > 0 && jsx("p", { style: { fontSize: 12, opacity: 0.7, margin: "4px 0 0" }, children: `尚未使用的邀請：${share.invites.map((i) => i.guestName).join("、")}` }),
				live && jsxs(Fragment, { children: [
					jsx("h3", { style: { fontSize: 14, margin: "14px 0 4px" }, children: "邀請新的訪客或重發連結" }),
					jsx("p", { style: { fontSize: 12, opacity: 0.7, margin: "0 0 4px" }, children: "同一個名字重發時，舊的未使用連結會失效。" }),
					jsxs("div", { style: { display: "flex", gap: 6 }, children: [
						jsx("input", { maxLength: 40, value: guestName, onChange: (e) => setGuestName(e.target.value), placeholder: "訪客名字", style: field, "data-share-room": "invite-name" }),
						jsx("button", { type: "button", style: btn({ height: 32 }), disabled: busy || guestName.trim() === "", "data-share-room": "invite", onClick: () => run(async () => { const r = await api("invite", { shareId: share.id, guestName }); setInvite({ path: r.invitePath, name: guestName }); setGuestName(""); }), children: "產生連結" }),
					] }),
					invite && jsxs("div", { style: { marginTop: 6 }, children: [jsx("span", { style: { fontSize: 13 }, children: `給「${invite.name}」的連結：` }), jsx(LinkBox, { path: invite.path })] }),
					jsx("h3", { style: { fontSize: 14, margin: "14px 0 4px" }, children: "問 AI" }),
					jsxs("label", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: 13 }, children: [
						jsx("input", { type: "checkbox", checked: aiPending ?? share.aiAllowed, disabled: busy, "data-share-room": "toggle-ai", onChange: (e) => { const next = e.target.checked; setAiPending(next); run(async () => { try { await api("settings", { shareId: share.id, aiAllowed: next }); } catch (err) { setAiPending(undefined); throw err; } }); } }),
						`允許訪客問 AI（已用 ${share.aiUsed} / ${share.aiBudget} 次）`,
					] }),
				] }),
				error && jsx("p", { role: "alert", style: { color: "#dc2626", fontSize: 13 }, children: error }),
				jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, marginTop: 18, flexWrap: "wrap" }, children: [
					live
						? jsx("button", { type: "button", style: btn({ height: 32, color: "#dc2626", borderColor: "#dc2626" }), disabled: busy, "data-share-room": "end", onClick: () => { if (window.confirm("結束分享？訪客會立刻無法發言和問 AI。")) run(() => api("end", { shareId: share.id })); }, children: "結束分享" })
						: share.access === "readonly"
							? jsx("button", { type: "button", style: btn({ height: 32, color: "#dc2626", borderColor: "#dc2626" }), disabled: busy, "data-share-room": "delete", onClick: () => { if (window.confirm("刪除唯讀頁？訪客將無法再閱讀或下載。")) run(() => api("delete", { shareId: share.id })); }, children: "刪除唯讀頁" })
							: jsx("span", {}),
					jsx("button", { type: "button", style: btn({ height: 32 }), onClick: onClose, children: "關閉" }),
				] }),
			] }) });
		}

		// ------------------------------------------------------------------
		// Header button

		function ShareButton({ ctx, sessionId }) {
			const state = useRoom(sessionId);
			const siteState = useSite();
			const [open, setOpen] = React.useState(false);
			const [ownerName, setOwnerName] = React.useState(undefined);
			const close = React.useCallback(() => setOpen(false), []);
			if (!state.loaded) return null;
			const share = state.share;
			if (share && !share.readOnlyDeleted && share.access !== "gone") {
				const guests = share.guests.filter((g) => !g.removedAt).length;
				return jsxs(Fragment, { children: [
					jsx("button", { type: "button", style: btn(isLive(share) ? { borderColor: "#16a34a", color: "#15803d" } : {}), "data-testid": "share-room-manage-button", "data-share-room-state": share.access, onClick: () => setOpen(true),
						children: isLive(share) ? `🔗 分享中 · ${guests} 位訪客` : "🔗 分享已結束" }),
					open && jsx(ManageDialog, { share, onClose: close }),
				] });
			}
			if (siteState.enabled === false) return null;
			const begin = async () => {
				try { const s = await api(`state?sessionId=${encodeURIComponent(sessionId)}`); setOwnerName(s.ownerName ?? ""); } catch { setOwnerName(""); }
				setOpen(true);
			};
			return jsxs(Fragment, { children: [
				jsx("button", { type: "button", style: btn(), "data-testid": "share-room-share-button", title: "把這個對話分享給別人一起討論", onClick: begin, children: "🔗 分享" }),
				open && ownerName !== undefined && jsx(CreateDialog, { ctx, sessionId, ownerName, onClose: close }),
			] });
		}

		// ------------------------------------------------------------------
		// Input: 💬/🤖 toggle and submit interception (shared sessions only)

		const patched = new WeakSet();
		function patchInput(ctx, sessionId) {
			const actx = ctx.sessions.scope(sessionId);
			const conversation = actx?.get("conversation");
			const input = conversation?.input?.for(actx);
			if (!input || patched.has(input)) return;
			patched.add(input);
			const original = input.submit.bind(input);
			input.submit = (mode) => {
				const state = input.state.getSnapshot();
				const text = state.draft.trim();
				const room = rooms.get(sessionId)?.store.get();
				if (!isLive(room?.share) || modeOf(sessionId).get() !== "discuss" || text === "" || text.startsWith("/") || state.phase !== "plain") {
					original(mode);
					return;
				}
				if (state.attachmentIds.length > 0) {
					input.notify("error", "💬 討論不能附加檔案或圖片；請切換到 🤖 問 AI 再送出。");
					return;
				}
				input.setDraft("");
				api("discuss", { sessionId, text }).catch((error) => {
					input.setDraft(text);
					input.notify("error", error instanceof Error ? error.message : String(error));
				});
			};
		}

		function ModeToggle({ ctx, sessionId }) {
			const state = useRoom(sessionId);
			const mode = useStore(modeOf(sessionId));
			React.useEffect(() => { if (isLive(state.share)) patchInput(ctx, sessionId); }, [state.share, sessionId]);
			if (!isLive(state.share)) return null;
			const discuss = mode === "discuss";
			return jsx("button", {
				type: "button", "data-share-room": "mode", "data-mode": mode,
				style: { ...btn({ height: 28, borderRadius: 14, padding: "0 10px" }), background: discuss ? "var(--dsw-alias-interactive-bg-active, #eef)" : "transparent" },
				title: discuss ? "💬 討論：大家即時看到，AI 不會回覆。點一下切換成問 AI。" : "🤖 問 AI：AI 會回覆，並讀到上次問 AI 之後的討論。點一下切換成討論。",
				onMouseDown: (e) => e.preventDefault(),
				onClick: () => modeOf(sessionId).set(discuss ? "ai" : "discuss"),
				children: discuss ? "💬 討論" : "🤖 問 AI",
			});
		}

		const timeOf = (at) => { try { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };

		function DiscussionDock({ sessionId }) {
			const state = useRoom(sessionId);
			const [showOld, setShowOld] = React.useState(false);
			const listRef = React.useRef(null);
			const pending = state.messages.filter((m) => m.seq > state.upTo);
			const old = state.messages.filter((m) => m.seq <= state.upTo);
			const visible = showOld ? state.messages : pending;
			React.useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [visible.length]);
			if (!state.share || state.messages.length === 0) return null;
			return jsxs("div", {
				"data-share-room": "discussion",
				style: { margin: "0 0 6px", padding: "6px 10px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2, #ddd)", fontSize: 13 },
				children: [
					jsxs("div", { style: { display: "flex", justifyContent: "space-between", opacity: 0.75, fontSize: 12, marginBottom: 4 }, children: [
						jsx("span", { children: pending.length > 0 ? `💬 討論（${pending.length} 則，下次問 AI 時會一起交給 AI）` : "💬 討論（都已交給 AI）" }),
						old.length > 0 && jsx("button", { type: "button", style: { background: "none", border: 0, cursor: "pointer", color: "inherit", fontSize: 12, textDecoration: "underline" }, onClick: () => setShowOld((v) => !v), children: showOld ? "隱藏已交給 AI 的" : `顯示較早的 ${old.length} 則` }),
					] }),
					jsx("div", { ref: listRef, style: { maxHeight: 180, overflowY: "auto" }, children: visible.map((m) => jsxs("div", {
						"data-share-room-message": m.seq,
						style: { padding: "2px 0", opacity: m.seq <= state.upTo ? 0.55 : 1, whiteSpace: "pre-wrap", wordBreak: "break-word" },
						children: [jsx("b", { style: { marginRight: 6 }, children: m.name }), jsx("span", { style: { opacity: 0.6, fontSize: 11, marginRight: 6 }, children: timeOf(m.at) }), m.text],
					}, m.seq)) }),
					!state.connected && jsx("div", { style: { fontSize: 11, opacity: 0.6 }, children: "連線中斷，重新連線中…" }),
				],
			});
		}

		// ------------------------------------------------------------------
		// Speaker badges on tagged user messages (any session).

		function SpeakerBadge({ speaker, discussion }) {
			return jsxs("div", {
				"data-share-room": "speaker",
				style: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.8, margin: "0 4px 2px" },
				children: [
					discussion.length > 0 && jsxs("details", { style: { fontSize: 12 }, children: [
						jsx("summary", { style: { cursor: "pointer" }, children: `附帶 ${discussion.length} 則討論` }),
						jsx("div", { style: { textAlign: "left", maxWidth: 480 }, children: discussion.map((row, i) => jsxs("div", { children: [jsx("b", { children: row.name }), "：", row.text] }, i)) }),
					] }),
					jsx("span", { style: { fontWeight: 600 }, children: speaker.role === "guest" ? `${speaker.name}（訪客）` : speaker.name }),
				],
			});
		}

		function makeUserNode(ctx, key) {
			return function ShareRoomUserNode(props) {
				const stock = React.useMemo(() => {
					const entries = typeof ctx.slots.entries === "function" ? ctx.slots.entries("conversation.chat.node") : [];
					return entries.filter((e) => e.options?.key === key && e.component?.[OWN] !== true)
						.sort((a, b) => (a.options?.priority ?? 0) - (b.options?.priority ?? 0))[0]?.component;
				}, []);
				const data = props.node?.data;
				// Only messages a person typed carry a speaker; anything synthesized
				// (subagent results, runtime context ...) is never badged.
				const split = data?.source?.kind === "user" ? splitTagged(data?.content) : undefined;
				const node = split ? { ...props.node, data: { ...data, content: split.content } } : props.node;
				const body = stock ? React.createElement(stock, { ...props, node }) : jsx("div", { style: { whiteSpace: "pre-wrap" }, children: (node.data?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n") });
				if (!split) return body;
				return jsxs(Fragment, { children: [jsx(SpeakerBadge, { speaker: split.speaker, discussion: split.discussion }), body] });
			};
		}

		// ------------------------------------------------------------------
		// Settings → General: the site switch

		function SiteSwitchRow() {
			const { enabled } = useSite();
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const toggle = async (e) => {
				const on = e.target.checked;
				if (!on && !window.confirm("關閉分享？所有訪客會立刻暫停，不能再發言或問 AI；分享和連結都會保留，重新開啟後恢復。")) return;
				setBusy(true); setError("");
				try { const r = await api("site", { enabled: on }); site.set(() => ({ enabled: r.enabled })); }
				catch (err) { setError(err instanceof Error ? err.message : String(err)); }
				finally { setBusy(false); }
			};
			return jsxs("div", { "data-testid": "share-room-site-row", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "16px 0", borderBottom: "1px solid var(--dsw-alias-border-l1, #eee)", color: "var(--dsw-alias-label-primary, inherit)" }, children: [
				jsxs("div", { style: { minWidth: 0 }, children: [
					jsx("div", { style: { fontSize: 14, lineHeight: "22px" }, children: "對話分享" }),
					jsx("div", { style: { fontSize: 12, lineHeight: "18px", opacity: 0.7 }, children: "允許把對話分享給沒有帳號的訪客（標題列的「🔗 分享」）。關閉時所有訪客暫停，分享不會被刪除。" }),
					error && jsx("div", { role: "alert", style: { fontSize: 12, color: "#dc2626" }, children: error }),
				] }),
				jsx("input", { type: "checkbox", role: "switch", "aria-label": "對話分享", "data-share-room": "site-enabled", checked: enabled === true, disabled: busy || enabled === undefined, onChange: toggle, style: { width: 18, height: 18, cursor: "pointer" } }),
			] });
		}

		const inject = ["slots", "sessions", "uiWorkspace"];
		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "share-room-share",
				inject: (sessionId) => ({ sessionId, ctx }),
			}, ShareButton));
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item", id: "share-room-site", order: 90,
				inject: () => ({}),
			}, SiteSwitchRow));
			for (const key of ["user", "steering"]) {
				const component = makeUserNode(ctx, key);
				component[OWN] = true;
				ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key, priority: -1, locale: "chat" }, component));
			}
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left", id: "share-room-mode", order: -10,
				inject: (sessionId) => ({ sessionId, ctx }),
			}, ModeToggle));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock", id: "share-room-discussion", order: 5,
				inject: (sessionId) => ({ sessionId }),
			}, DiscussionDock));
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.parseTagged = parseTagged;
		return module.exports;
	}
});
