// Gemini API helper for generating flashcards and quizzes.
//
// API keys live in the D1 table `api_keys` (managed by admins in the
// dashboard → "API Keys"). Requests are spread over the keys with
// ROUND-ROBIN LOAD BALANCING: request 1 → Key A, request 2 → Key B,
// request 3 → Key C, request 4 → Key A again, ...
// If the chosen key fails (quota / invalid), the next key in the rotation
// is tried automatically so the user still gets a result.

// RESILIENCE LAYER (v7)
//  1. Automatic multi-tier model fallback:
//       gemini-3.8-flash → gemini-3.1-flash-lite → gemini-flash-latest
//     If the primary model is overloaded / out of capacity, the request is
//     routed to the next fast model instead of failing.
//  2. Exponential backoff with jitter for transient errors
//     (HTTP 429, 500, 502, 503, 504, "UNAVAILABLE", network / timeout).
//  3. thinkingLevel: "LOW" for Gemini 3 series models (lower latency + tokens).
//  4. Every failure is converted into a GeminiError with a clean, human
//     friendly message (never raw JSON) that the client can show + retry.
// All of this applies to EVERY API key in the pool (Key A, Key B, Key C...).

// Used only if the api_keys table is empty / not migrated yet.
const FALLBACK_GEMINI_API_KEY = 'AIzaSyDTkLMabFgMQzkvF0vNoaE3D4QyTzmhvzs'

/** Ordered fallback chain — fastest / newest first. */
export const MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest']

const RETRY = {
  attemptsPerModel: 3,   // 1 try + 2 retries on transient errors
  baseDelayMs: 600,      // 600ms, 1.2s, 2.4s ... (+ jitter)
  maxDelayMs: 6000,
  requestTimeoutMs: 60000 // abort a single HTTP call after 60s
}
const TRANSIENT = new Set([429, 500, 502, 503, 504])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Exponential backoff with "full jitter": random between 50% and 100% of the exp. delay. */
function backoff(attempt: number, retryAfterMs = 0) {
  const exp = Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * 2 ** attempt)
  const jittered = exp / 2 + Math.random() * (exp / 2)
  return Math.max(jittered, Math.min(retryAfterMs, RETRY.maxDelayMs))
}

/** Gemini 3 series → thinkingLevel LOW. (flash-latest currently points to Gemini 3.x too.) */
const supportsThinkingLevel = (model: string) => /^gemini-3/.test(model) || model === 'gemini-flash-latest'

// ---------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------
export type GeminiErrorCode = 'rate_limited' | 'overloaded' | 'invalid_key' | 'no_keys' | 'timeout' | 'network' | 'blocked' | 'bad_response' | 'unknown'

const FRIENDLY: Record<GeminiErrorCode, string> = {
  rate_limited: 'The AI is getting a lot of requests right now (rate limit reached). Please wait a few seconds and try again.',
  overloaded: 'The AI servers are very busy at the moment. We tried several models but none were available. Please try again in a moment.',
  invalid_key: 'The AI service is not configured correctly (no working API key). Please contact the admin.',
  no_keys: 'No active AI API keys are available. Please ask the admin to add or resume a key.',
  timeout: 'The AI took too long to respond. Try again, or use shorter text / fewer cards.',
  network: 'Could not reach the AI service. Check your connection and try again.',
  blocked: 'The AI could not process this content (it was blocked by safety filters). Try editing the text.',
  bad_response: 'The AI returned an incomplete answer. Please try again.',
  unknown: 'Something went wrong while talking to the AI. Please try again.'
}

export class GeminiError extends Error {
  code: GeminiErrorCode
  status: number          // HTTP status to send to the client
  retryable: boolean
  retryAfter: number      // seconds the client should wait before retrying
  detail?: string         // short technical detail (for logs / admin only)
  constructor(code: GeminiErrorCode, detail?: string, retryAfter = 0) {
    super(FRIENDLY[code])
    this.name = 'GeminiError'
    this.code = code
    this.detail = detail
    this.retryable = !['invalid_key', 'no_keys', 'blocked'].includes(code)
    this.status = code === 'rate_limited' ? 429 : code === 'blocked' ? 422 : code === 'timeout' ? 504 : 503
    this.retryAfter = retryAfter || (code === 'rate_limited' ? 15 : code === 'overloaded' ? 10 : this.retryable ? 5 : 0)
  }
}

/** Pulls the human part out of a Google error body — never returns raw JSON. */
export function parseGoogleError(status: number, text: string): { message: string; reason: string; retryAfterMs: number } {
  let message = '', reason = '', retryAfterMs = 0
  try {
    const j = JSON.parse(text)
    const e = Array.isArray(j) ? j[0]?.error : j?.error
    message = String(e?.message || '')
    reason = String(e?.status || '')
    for (const d of e?.details || []) {
      if (d?.reason) reason = reason || d.reason
      if (d?.retryDelay) retryAfterMs = (parseFloat(String(d.retryDelay)) || 0) * 1000
    }
  } catch (e) {
    message = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  message = message.split('\n')[0].slice(0, 180) || `HTTP ${status}`
  return { message, reason, retryAfterMs }
}

/** Convert anything thrown into a GeminiError (used by routes). */
export function toGeminiError(e: any): GeminiError {
  if (e instanceof GeminiError) return e
  if (e instanceof SyntaxError) return new GeminiError('bad_response', e.message)
  return new GeminiError('unknown', String(e?.message || e).slice(0, 200))
}

// ---------------------------------------------------------------------------
// Key pool (round-robin)
// ---------------------------------------------------------------------------
let DB: D1Database | null = null
/** Called once per request (middleware) so the helper can read the key pool. */
export function setGeminiDb(db: D1Database) { DB = db }

type KeyRow = { id: number; label: string; api_key: string }

/** Active keys in rotation order (Key A, Key B, Key C ...). */
export async function listActiveKeys(db: D1Database | null = DB): Promise<KeyRow[]> {
  if (!db) return []
  try {
    const { results } = await db.prepare(
      "SELECT id, label, api_key FROM api_keys WHERE provider = 'gemini' AND active = 1 ORDER BY id"
    ).all<KeyRow>()
    return results || []
  } catch (e) {
    return [] // table not migrated yet
  }
}

/** Atomically advance the round-robin counter and return the ordered key list for this request. */
async function keysForRequest(): Promise<KeyRow[]> {
  const keys = await listActiveKeys()
  if (!keys.length) {
    // Table exists but everything is paused/deleted → tell the user; table missing → built-in key.
    let tableExists = false
    try { if (DB) { await DB.prepare('SELECT 1 FROM api_keys LIMIT 1').first(); tableExists = true } } catch (e) {}
    if (tableExists) throw new GeminiError('no_keys')
    return [{ id: 0, label: 'Fallback', api_key: FALLBACK_GEMINI_API_KEY }]
  }
  let counter = 0
  try {
    const row = await DB!.prepare(
      "INSERT INTO app_state (key, value) VALUES ('gemini_rr', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value"
    ).first<{ value: number }>()
    counter = (row?.value ?? 1) - 1
  } catch (e) {
    counter = Math.floor(Math.random() * keys.length)
  }
  const start = counter % keys.length
  // e.g. 3 keys, start=1 → [B, C, A]  (B is used; C, A are fail-over only)
  return [...keys.slice(start), ...keys.slice(0, start)]
}

async function markKey(k: KeyRow, status: string) {
  if (!DB || !k.id) return
  try {
    await DB.prepare(
      'UPDATE api_keys SET uses = uses + 1, last_used_at = CURRENT_TIMESTAMP, last_status = ? WHERE id = ?'
    ).bind(status.slice(0, 200), k.id).run()
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Low-level request
// ---------------------------------------------------------------------------
function buildBody(prompt: string, model: string, opts: { maxTokens: number; json: boolean; temperature: number; thinking: boolean }) {
  const generationConfig: any = { temperature: opts.temperature, maxOutputTokens: opts.maxTokens }
  if (opts.json) generationConfig.responseMimeType = 'application/json'
  if (opts.thinking && supportsThinkingLevel(model)) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' }
  return JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig })
}

/** One raw call with a specific key + model (with timeout). */
export async function geminiRequest(apiKey: string, model: string, body: string, timeoutMs = RETRY.requestTimeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal }
    )
  } finally {
    clearTimeout(timer)
  }
}

const isKeyProblem = (status: number, msg: string, reason: string) =>
  status === 401 || status === 403 ||
  (status === 400 && /API[_ ]?KEY|api key|API_KEY_INVALID|PERMISSION/i.test(msg + ' ' + reason))

export interface CallOptions {
  maxTokens?: number
  json?: boolean
  temperature?: number
  /** Stop trying new models/keys after this many ms (the dual-batch safeguard uses a shorter budget). */
  deadlineMs?: number
  /** Fail fast on rate-limit / capacity errors (skip remaining retries) so a caller can switch strategy. */
  failFastOnCapacity?: boolean
}

/**
 * Resilient Gemini call used for EVERY key:
 *   for key in rotation (A → B → C):
 *     for model in [3.8-flash → 3.1-flash-lite → flash-latest]:
 *       up to 3 attempts, exponential backoff + jitter on 429/5xx/network
 */
export async function callGemini(prompt: string, maxTokensOrOpts: number | CallOptions = 8192): Promise<string> {
  const o: CallOptions = typeof maxTokensOrOpts === 'number' ? { maxTokens: maxTokensOrOpts } : maxTokensOrOpts
  const opts = { maxTokens: o.maxTokens ?? 8192, json: o.json ?? true, temperature: o.temperature ?? 0.7 }
  const deadline = Date.now() + (o.deadlineMs ?? 110000)

  const keys = await keysForRequest()
  const seen = { rate: 0, busy: 0, timeout: 0, network: 0, key: 0, blocked: 0, bad: 0 }
  let retryAfterMs = 0
  let lastDetail = ''

  for (const key of keys) {
    let keyDead = false
    let keyRateLimited = 0
    for (const model of MODELS) {
      if (keyDead) break
      let thinking = true
      for (let attempt = 0; attempt < RETRY.attemptsPerModel; attempt++) {
        if (Date.now() > deadline) break
        let res: Response
        try {
          const remaining = Math.max(5000, Math.min(RETRY.requestTimeoutMs, deadline - Date.now()))
          res = await geminiRequest(key.api_key, model, buildBody(prompt, model, { ...opts, thinking }), remaining)
        } catch (e: any) {
          const aborted = e?.name === 'AbortError'
          aborted ? seen.timeout++ : seen.network++
          lastDetail = `${key.label}/${model}: ${aborted ? 'timeout' : e?.message || 'network error'}`
          if (aborted) break // a timed-out model → go straight to the next (faster) model
          await sleep(backoff(attempt))
          continue
        }

        if (res.ok) {
          const data: any = await res.json().catch(() => null)
          const cand = data?.candidates?.[0]
          const text = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('')
          if (text) { await markKey(key, `ok · ${model}`); return text }
          if (data?.promptFeedback?.blockReason || cand?.finishReason === 'SAFETY') {
            seen.blocked++
            throw new GeminiError('blocked', String(data?.promptFeedback?.blockReason || 'SAFETY'))
          }
          seen.bad++
          lastDetail = `${key.label}/${model}: empty response (${cand?.finishReason || 'no candidates'})`
          break // try next model
        }

        const errText = await res.text()
        const g = parseGoogleError(res.status, errText)
        lastDetail = `${key.label}/${model}: ${res.status} ${g.reason} ${g.message}`.trim()

        // thinkingLevel not accepted by this model → retry immediately without it
        if (res.status === 400 && thinking && /thinking/i.test(g.message)) { thinking = false; attempt--; continue }

        if (isKeyProblem(res.status, g.message, g.reason)) {
          seen.key++
          keyDead = true
          await markKey(key, 'error ' + res.status + ': ' + g.message)
          break
        }
        if (res.status === 404) break // model not available for this key → next model

        if (TRANSIENT.has(res.status) || /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(g.reason + g.message)) {
          if (res.status === 429 || /RESOURCE_EXHAUSTED/i.test(g.reason)) { seen.rate++; keyRateLimited++ } else seen.busy++
          retryAfterMs = Math.max(retryAfterMs, g.retryAfterMs)
          if (o.failFastOnCapacity) break // let the caller switch strategy (dual-batch)
          // A 429 usually means this model's quota for this key is used up → one retry, then next model
          if (res.status === 429 && attempt >= 1) break
          if (attempt < RETRY.attemptsPerModel - 1) await sleep(backoff(attempt, g.retryAfterMs))
          continue
        }
        // Other 4xx (bad request) → not going to fix itself with retries on this model
        break
      }
    }
    if (keyRateLimited >= MODELS.length) await markKey(key, 'error 429: rate limited')
    if (Date.now() > deadline) break
  }

  const ra = Math.ceil(retryAfterMs / 1000)
  if (seen.rate) throw new GeminiError('rate_limited', lastDetail, ra)
  if (seen.busy) throw new GeminiError('overloaded', lastDetail, ra)
  if (seen.timeout) throw new GeminiError('timeout', lastDetail)
  if (seen.network) throw new GeminiError('network', lastDetail)
  if (seen.bad) throw new GeminiError('bad_response', lastDetail)
  if (seen.key) throw new GeminiError('invalid_key', lastDetail)
  throw new GeminiError('unknown', lastDetail)
}

/** Check whether an API key works (used when an admin adds / tests a key).
 *  Goes through the same model fallback chain + backoff.
 *  - 200 → works
 *  - 400/401/403 (key) → invalid → rejected
 *  - 429 on every model → quota exhausted → rejected
 *  - 5xx on every model → Google authenticated the key but is overloaded → accepted */
export async function testGeminiKey(apiKey: string): Promise<{ ok: boolean; model?: string; error?: string; note?: string }> {
  let lastErr = ''
  let busy = 0, rate = 0
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = buildBody('Reply with the single word: OK', model, { maxTokens: 20, json: false, temperature: 0, thinking: true })
        const res = await geminiRequest(apiKey, model, body, 20000)
        if (res.ok) return { ok: true, model }
        const g = parseGoogleError(res.status, await res.text())
        lastErr = `${res.status}: ${g.message}`
        if (isKeyProblem(res.status, g.message, g.reason)) return { ok: false, error: 'Invalid API key — ' + g.message }
        if (res.status === 429) { rate++; await sleep(backoff(attempt)); continue }
        if (TRANSIENT.has(res.status)) { busy++; await sleep(backoff(attempt)); continue }
        break
      } catch (e: any) {
        lastErr = e?.name === 'AbortError' ? 'timed out' : e?.message || 'network error'
        break
      }
    }
  }
  if (busy > 0) return { ok: true, note: 'Key is valid (Gemini was busy during the check)' }
  if (rate > 0) return { ok: false, error: 'Rate limit / quota reached for this key — try again later.' }
  return { ok: false, error: lastErr || 'Key did not respond' }
}

function extractJson(text: string): any {
  // Strip markdown fences if present
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '')
  const firstBrace = cleaned.search(/[\[{]/)
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace)
  return JSON.parse(cleaned)
}

export interface Flashcard {
  front: string
  back: string
}

function flashcardPrompt(sourceText: string, count: number, focus?: string, avoid: string[] = []) {
  const focusText = focus ? `\nFOCUS for this batch: ${focus}\n` : ''
  const avoidText = avoid.length ? `\nDo NOT repeat any of these already-created cards:\n${avoid.map((f) => '- ' + f).join('\n')}\n` : ''
  return `You are an expert study assistant. Based ONLY on the study material below, create exactly ${count} flashcards that help a student review the key concepts.
${focusText}${avoidText}
Each flashcard must have a "front" (a concise question, term, or concept) and a "back" (a clear, accurate answer or explanation).

Return ONLY a valid JSON array in this exact format, with no extra text:
[{"front": "question or term", "back": "answer or explanation"}]

STUDY MATERIAL:
"""
${sourceText.slice(0, 25000)}
"""`
}

function cleanCards(raw: string): Flashcard[] {
  const parsed = extractJson(raw)
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.flashcards) ? parsed.flashcards : Array.isArray(parsed?.cards) ? parsed.cards : null
  if (!list) throw new GeminiError('bad_response', 'Expected an array of flashcards')
  return list
    .filter((c: any) => c && c.front && c.back)
    .map((c: any) => ({ front: String(c.front), back: String(c.back) }))
}

const normFront = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function dedupeCards(cards: Flashcard[]) {
  const seen = new Set<string>()
  return cards.filter((c) => { const k = normFront(c.front); if (!k || seen.has(k)) return false; seen.add(k); return true })
}

/** Errors that mean "one big prompt is too heavy right now" → switch to dual-batch. */
const shouldSplit = (e: any) =>
  e instanceof SyntaxError || (e instanceof GeminiError && ['rate_limited', 'overloaded', 'timeout', 'bad_response'].includes(e.code))

export type FlashcardStrategy = 'single' | 'dual-batch'

/**
 * DUAL-BATCH GENERATION SAFEGUARD
 * Large sets (> 25 cards, e.g. 50) are first tried as ONE prompt (fail-fast on
 * capacity errors). If that hits a rate limit / capacity problem / timeout /
 * truncated JSON, the set is generated as TWO smaller batches instead:
 *   Batch 1 → core definitions & concepts          (e.g. 25 cards)
 *   Batch 2 → principles, mechanisms & applications (e.g. 25 cards)
 * The two results are merged, de-duplicated and trimmed to the requested count.
 */
export async function generateFlashcardsDetailed(
  sourceText: string,
  count: number
): Promise<{ cards: Flashcard[]; strategy: FlashcardStrategy }> {
  const n = Math.max(1, Math.floor(count))
  const SPLIT_AT = 25

  if (n <= SPLIT_AT) {
    const cards = cleanCards(await callGemini(flashcardPrompt(sourceText, n)))
    return { cards: dedupeCards(cards).slice(0, n), strategy: 'single' }
  }

  // 1) Try a single prompt, but fail fast so we can switch strategy quickly.
  try {
    const raw = await callGemini(flashcardPrompt(sourceText, n), { maxTokens: 16384, failFastOnCapacity: true, deadlineMs: 55000 })
    const cards = dedupeCards(cleanCards(raw))
    if (cards.length >= Math.floor(n * 0.8)) return { cards: cards.slice(0, n), strategy: 'single' }
    // Too few cards came back (output was cut) → top up via the dual-batch path below.
  } catch (e) {
    if (!shouldSplit(e)) throw e
  }

  // 2) Dual-batch fallback (both halves in parallel; a failed half is retried with full backoff).
  const a = Math.ceil(n / 2)
  const b = n - a
  const FOCUS_A = 'CORE DEFINITIONS AND CONCEPTS — key terms, definitions, fundamental ideas, classifications, and important facts.'
  const FOCUS_B = 'PRINCIPLES, MECHANISMS AND APPLICATIONS — how and why things work, processes, cause-and-effect, comparisons, and real-world applications/examples. Avoid simple term definitions.'
  const runBatch = (cnt: number, focus: string, avoid: string[] = []) =>
    callGemini(flashcardPrompt(sourceText, cnt, focus, avoid), { maxTokens: 12288 }).then(cleanCards)

  const [ra, rb] = await Promise.allSettled([runBatch(a, FOCUS_A), runBatch(b, FOCUS_B)])
  let batchA: Flashcard[] = ra.status === 'fulfilled' ? ra.value : []
  let batchB: Flashcard[] = rb.status === 'fulfilled' ? rb.value : []
  // Retry a failed half once (sequentially, after the other half is done → less pressure on the API)
  if (ra.status === 'rejected') {
    try { batchA = await runBatch(a, FOCUS_A, batchB.map((c) => c.front)) } catch (e) { if (!batchB.length) throw toGeminiError(ra.reason) }
  }
  if (rb.status === 'rejected') {
    try { batchB = await runBatch(b, FOCUS_B, batchA.map((c) => c.front)) } catch (e) { if (!batchA.length) throw toGeminiError(rb.reason) }
  }

  const merged = dedupeCards([...batchA.slice(0, a), ...batchB.slice(0, b), ...batchA.slice(a), ...batchB.slice(b)])
  if (!merged.length) throw new GeminiError('bad_response', 'dual-batch produced no cards')
  return { cards: merged.slice(0, n), strategy: 'dual-batch' }
}

export async function generateFlashcards(sourceText: string, count: number): Promise<Flashcard[]> {
  return (await generateFlashcardsDetailed(sourceText, count)).cards
}

// Generate a short, descriptive title from study material when the user
// didn't provide one.
export async function generateTitle(sourceText: string): Promise<string> {
  const prompt = `Read the study material below and produce a short, descriptive title (3 to 6 words) that captures its main topic. Return ONLY valid JSON in this exact format, no extra text:
{"title": "Your Title Here"}

STUDY MATERIAL:
"""
${sourceText.slice(0, 4000)}
"""`
  try {
    const raw = await callGemini(prompt)
    const parsed = extractJson(raw)
    const title = parsed && parsed.title ? String(parsed.title).trim() : ''
    if (title) return title.slice(0, 80)
  } catch (e) {
    // fall through to default
  }
  return 'Flashcards ' + new Date().toLocaleDateString()
}

export interface QuizQuestion {
  type: 'multiple_choice' | 'situational' | 'true_false' | 'identification'
  question: string
  options?: string[]      // for multiple_choice / situational
  answer: string          // the correct answer
  explanation?: string
}

const TYPE_INSTRUCTIONS: Record<string, string> = {
  multiple_choice:
    'multiple_choice: a question with an "options" array of 4 choices; "answer" must exactly match one option.',
  situational:
    'situational: a real-life scenario-based question with an "options" array of 4 choices; "answer" must exactly match one option.',
  true_false:
    'true_false: a statement to judge; "options" must be ["True","False"] and "answer" is "True" or "False".',
  identification:
    'identification: an open question where the student types the exact term; no "options" needed, "answer" is the correct term.'
}

export async function generateQuiz(
  cards: Flashcard[],
  types: string[],
  count: number = 10,
  difficulty: string = 'medium'
): Promise<QuizQuestion[]> {
  const validTypes = types.filter((t) => TYPE_INSTRUCTIONS[t])
  if (validTypes.length === 0) throw new Error('No valid quiz types selected')

  const n = Math.min(50, Math.max(10, Number(count) || 10))
  const instructions = validTypes.map((t) => '- ' + TYPE_INSTRUCTIONS[t]).join('\n')
  const cardText = cards
    .map((c, i) => `${i + 1}. Q: ${c.front} | A: ${c.back}`)
    .join('\n')

  const DIFFICULTY_GUIDE: Record<string, string> = {
    easy: 'EASY: straightforward recall questions, clear wording, obviously wrong distractors.',
    medium: 'MEDIUM: mix of recall and understanding, plausible distractors.',
    hard: 'HARD: application / analysis questions, tricky but fair wording, very plausible distractors that test deep understanding.'
  }
  const diffText = DIFFICULTY_GUIDE[difficulty] || DIFFICULTY_GUIDE.medium

  const prompt = `You are an expert quiz maker. Based ONLY on the flashcards below, create exactly ${n} quiz questions.

Difficulty level: ${diffText}

Use ONLY these question types, distributed roughly evenly across them:
${instructions}

Each question object must have:
- "type": one of ${JSON.stringify(validTypes)}
- "question": the question text
- "options": array of choices (required for multiple_choice, situational, true_false; omit or empty for identification)
- "answer": the correct answer (must exactly match one option when options exist)
- "explanation": a short reason why the answer is correct

Return ONLY a valid JSON array with no extra text:
[{"type":"...","question":"...","options":["..."],"answer":"...","explanation":"..."}]

FLASHCARDS:
${cardText}`

  // Parse; if the JSON came back truncated/invalid, regenerate once (goes through the full fallback chain again).
  let parsed: any
  for (let i = 0; i < 2; i++) {
    try {
      const raw = await callGemini(prompt, n > 25 ? 16384 : 8192)
      const p = extractJson(raw)
      parsed = Array.isArray(p) ? p : Array.isArray(p?.questions) ? p.questions : null
      if (parsed) break
    } catch (e) {
      if (!(e instanceof SyntaxError) || i === 1) throw toGeminiError(e)
    }
  }
  if (!Array.isArray(parsed)) throw new GeminiError('bad_response', 'Expected an array of questions')
  return parsed
    .filter((q: any) => q && q.type && q.question && q.answer)
    .map((q: any) => ({
      type: q.type,
      question: String(q.question),
      options: Array.isArray(q.options) ? q.options.map(String) : undefined,
      answer: String(q.answer),
      explanation: q.explanation ? String(q.explanation) : undefined
    }))
    .slice(0, n)
}

// ---------------------------------------------------------------------------
// QUIZ MAKER (AI): turn pasted / PDF-extracted questions into a quiz.
// - Detects each question + its choices and the best question type.
// - If the source provides answers, keeps them; otherwise the AI answers.
// ---------------------------------------------------------------------------
export async function parseQuizFromText(
  sourceText: string,
  difficulty: string = 'medium'
): Promise<{ title: string; questions: QuizQuestion[] }> {
  const prompt = `You are an expert quiz maker. The text below contains quiz questions written by a teacher/student (it may come from a PDF, so formatting can be messy). Your job is to convert it into a clean, playable quiz.

RULES:
1. Extract EVERY question found in the text, in the same order. Do not invent extra questions unless the text contains no questions at all (in that case, create 10 good questions from the text as study material; difficulty: ${difficulty}).
2. Keep the question wording and the choices as close to the original as possible (remove numbering like "1." and letter prefixes like "A." / "a)" from choices).
3. Decide each question's "type":
   - "multiple_choice": has choices (A/B/C/D...).
   - "situational": a scenario-based question with choices.
   - "true_false": a True/False statement; options must be ["True","False"].
   - "identification": no choices; the student types the answer.
4. ANSWERS: if the text provides the correct answer (answer key, "Answer: B", marked with *, bold, underline, "(correct)", an answer list at the end, etc.), use it. If NO answer is provided for a question, YOU must determine the correct answer yourself using accurate knowledge.
5. When a question has options, "answer" MUST be copied EXACTLY from one of the options (the option text, not the letter).
6. Add a short "explanation" of why the answer is correct.
7. Also produce a short descriptive quiz "title" (3-6 words) based on the topic.

Return ONLY valid JSON in this exact format, no extra text:
{"title":"...","questions":[{"type":"multiple_choice","question":"...","options":["...","..."],"answer":"...","explanation":"...","answer_provided":true}]}
("answer_provided" = true if the answer came from the text, false if you determined it.)

TEXT:
"""
${sourceText.slice(0, 30000)}
"""`

  let parsed: any
  try {
    parsed = extractJson(await callGemini(prompt, 32768))
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    parsed = extractJson(await callGemini(prompt, 32768)) // truncated JSON → one more try
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.questions
  if (!Array.isArray(list)) throw new Error('AI could not read the questions. Try cleaning up the text.')
  const types = ['multiple_choice', 'situational', 'true_false', 'identification']
  const questions: QuizQuestion[] = list
    .filter((q: any) => q && q.question && q.answer)
    .map((q: any) => {
      let type = types.includes(q.type) ? q.type : (Array.isArray(q.options) && q.options.length ? 'multiple_choice' : 'identification')
      let options: string[] | undefined = Array.isArray(q.options) ? q.options.map((o: any) => String(o).trim()).filter(Boolean) : undefined
      let answer = String(q.answer).trim()
      if (type === 'true_false') {
        options = ['True', 'False']
        answer = /^t/i.test(answer) ? 'True' : 'False'
      }
      if (type === 'identification') options = undefined
      if (options && options.length) {
        // make sure the answer matches an option exactly (letter answers like "B" → option text)
        const exact = options.find((o) => o.toLowerCase() === answer.toLowerCase())
        if (exact) answer = exact
        else if (/^[a-h]$/i.test(answer)) {
          const idx = answer.toUpperCase().charCodeAt(0) - 65
          if (options[idx]) answer = options[idx]
        } else {
          const partial = options.find((o) => o.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(o.toLowerCase()))
          if (partial) answer = partial
          else options.push(answer)
        }
      }
      return {
        type,
        question: String(q.question).trim(),
        options,
        answer,
        explanation: q.explanation ? String(q.explanation) : undefined,
        answer_provided: q.answer_provided === true
      } as any
    })
  const title = parsed && !Array.isArray(parsed) && parsed.title ? String(parsed.title).slice(0, 80) : ''
  return { title, questions }
}
