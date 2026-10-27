// Questions the AI asks while a session is shared: ask_user_question choices and
// the plan-mode review (exit_plan_mode), both delivered by DSH through the
// Agent-scoped `user-questions/request` waterfall.
//
// The owner's DSH Web page answers through that same waterfall. While a share is
// active this plugin ALSO offers the question to the room, so a partner can take
// over when the owner is away. Who may answer follows the share's AI permission:
//
//   full access (danger-full-access) -> every guest may answer
//   anything narrower                -> guests see that the AI waits, only the owner answers
//
// The first answer wins (owner page or a guest); the other side is withdrawn.
// Nothing here widens what the AI may do: answering a question is not a
// permission approval, and approvals stay with the owner.

export const QUESTION_TTL_MS = 6 * 60 * 60 * 1000 // a stale question is dropped from the room
const MAX_QUESTIONS = 8
const MAX_OPTIONS = 12
const MAX_TEXT = 4000

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

/** The part of a DSH question that guests may see. Never forwards agent internals. */
export function publicQuestion(q) {
  const isPlan = q?.intent?.kind === 'plan-review'
  return {
    id: clip(q?.id, 120),
    header: clip(q?.header, 80),
    question: clip(q?.question, MAX_TEXT),
    detail: clip(q?.detail, isPlan ? 60_000 : MAX_TEXT),
    multiSelect: q?.multiSelect === true,
    plan: isPlan,
    approve: isPlan ? clip(q?.intent?.approve, 200) : '',
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, MAX_OPTIONS).map((o) => ({
      label: clip(o?.label, 200),
      description: clip(o?.description, 600),
    })),
  }
}

/**
 * Validate a guest answer against the asked questions. Returns the DSH answer
 * shape `{ answers: [{ id, selected, custom? }] }` or throws.
 */
export function normalizeAnswer(questions, body) {
  const given = Array.isArray(body?.answers) ? body.answers : null
  if (!given) throw new Error('answers must be an array')
  const out = []
  for (const q of questions) {
    const a = given.find((x) => x?.id === q.id) ?? { id: q.id, selected: [] }
    const labels = new Set(q.options.map((o) => o.label))
    const selected = (Array.isArray(a.selected) ? a.selected : []).filter((s) => typeof s === 'string' && labels.has(s))
    if (!q.multiSelect && selected.length > 1) throw new Error(`question ${q.id} takes one choice`)
    const custom = typeof a.custom === 'string' && a.custom.trim() !== '' ? a.custom.trim().slice(0, MAX_TEXT) : undefined
    const entry = { id: q.id, selected: !q.multiSelect && custom !== undefined ? [] : selected }
    if (custom !== undefined) entry.custom = custom
    out.push(entry)
  }
  return { answers: out }
}

/** One readable line for the room: who answered what. */
export function answerSummary(questions, answer) {
  return answer.answers.map((a) => {
    const q = questions.find((x) => x.id === a.id)
    const picked = [...a.selected, ...(a.custom ? [`「${a.custom.slice(0, 120)}」`] : [])].join('、') || '（略過）'
    return q?.plan ? picked : `${q?.header || q?.question?.slice(0, 40) || a.id}：${picked}`
  }).join('；')
}

/**
 * Pending questions per shared session.
 * onChange(sessionId) runs whenever the set for a session changes.
 */
export class QuestionBoard {
  constructor({ onChange = () => {}, now = Date.now } = {}) {
    this.pending = new Map() // id -> { id, sessionId, questions, askedAt, settle }
    this.onChange = onChange
    this.now = now
    this.seq = 0
  }

  forSession(sessionId) {
    const now = this.now()
    return [...this.pending.values()]
      .filter((p) => p.sessionId === sessionId && now - p.askedAt < QUESTION_TTL_MS)
      .map(({ id, questions, askedAt }) => ({ id, questions, askedAt }))
  }

  /**
   * Offer a question. Resolves with { kind: 'answered', answer, by } when a guest
   * answers, or { kind: 'withdrawn' } when withdraw() is called (owner answered,
   * the turn ended, or the share stopped).
   */
  offer(sessionId, rawQuestions) {
    const questions = (Array.isArray(rawQuestions) ? rawQuestions : []).slice(0, MAX_QUESTIONS).map(publicQuestion)
    const id = `q${++this.seq}-${this.now().toString(36)}`
    let settle
    const done = new Promise((resolve) => { settle = resolve })
    this.pending.set(id, { id, sessionId, questions, askedAt: this.now(), settle })
    this.onChange(sessionId)
    return { id, questions, done }
  }

  /** A guest answer. Returns the normalized answer, or throws if gone or invalid. */
  answer(id, body, by) {
    const p = this.pending.get(id)
    if (!p) throw Object.assign(new Error('這個問題已經有人回答，或已經結束。'), { code: 'gone' })
    const answer = normalizeAnswer(p.questions, body)
    this.pending.delete(id)
    p.settle({ kind: 'answered', answer, by })
    this.onChange(p.sessionId)
    return { answer, questions: p.questions, sessionId: p.sessionId }
  }

  withdraw(id) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.settle({ kind: 'withdrawn' })
    this.onChange(p.sessionId)
  }

  withdrawSession(sessionId) {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) this.withdraw(p.id)
  }
}
