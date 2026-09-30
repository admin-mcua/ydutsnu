// Shared helpers used across all pages.
// Friendly text for HTTP statuses when the server didn't send a message.
const STATUS_TEXT = {
  400: 'The request was not valid. Please check your input.',
  401: 'Your session has expired. Please log in again.',
  403: 'You do not have permission to do that.',
  404: 'That item could not be found.',
  408: 'The request timed out. Please try again.',
  413: 'That is too much data. Try shorter text.',
  429: 'Too many requests right now. Please wait a moment and try again.',
  500: 'Something went wrong on the server. Please try again.',
  502: 'The server is temporarily unreachable. Please try again.',
  503: 'The service is busy right now. Please try again in a moment.',
  504: 'The server took too long to respond. Please try again.'
}

// Turns any error text into something readable (never shows raw JSON / HTML).
export function cleanErrorText(raw, status) {
  let msg = String(raw || '').trim()
  if (/^[\[{]/.test(msg)) {
    try { const j = JSON.parse(msg); msg = j?.error?.message || j?.error || j?.message || '' } catch (e) { msg = '' }
  }
  if (/<\/?[a-z][\s\S]*>/i.test(msg)) msg = ''
  if (typeof msg !== 'string') msg = ''
  if (msg.length > 240) msg = msg.slice(0, 240) + '…'
  return msg || STATUS_TEXT[status] || 'Something went wrong. Please try again.'
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, retryAfter = 0 } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.retryAfter = retryAfter
  }
}

export const api = async (path, opts = {}) => {
  const token = localStorage.getItem('token')
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (token) headers['Authorization'] = 'Bearer ' + token
  let res
  try {
    res = await fetch(path, { ...opts, headers })
  } catch (e) {
    throw new ApiError('Could not connect. Check your internet connection and try again.', { code: 'network', retryable: true, retryAfter: 3 })
  }
  let data = {}
  let text = ''
  try { text = await res.text(); data = text ? JSON.parse(text) : {} } catch (e) { data = {} }
  if (!res.ok) {
    const retryAfter = Number(data.retry_after || res.headers.get('Retry-After') || 0)
    const retryable = data.retryable !== undefined ? !!data.retryable : [408, 429, 500, 502, 503, 504].includes(res.status)
    throw new ApiError(cleanErrorText(data.error || text, res.status), { status: res.status, code: data.code || '', retryable, retryAfter })
  }
  return data
}

// ---------------- AI ERROR NOTICE (with retry) ----------------
const AI_ERROR_TITLES = {
  rate_limited: 'AI is busy (rate limit)',
  overloaded: 'AI servers are overloaded',
  timeout: 'AI took too long',
  network: 'Connection problem',
  invalid_key: 'AI is not configured',
  no_keys: 'No AI keys available',
  blocked: 'Content could not be processed',
  bad_response: 'Incomplete AI answer'
}

/**
 * Shows a clean error card inside `target` with a "Try again" button.
 * Retryable errors show a countdown (from retry_after) and then enable the button.
 * `onRetry` is called when the user clicks "Try again".
 */
export function showAiError(target, err, onRetry) {
  if (!target) return toast(err?.message || 'Something went wrong', 'error')
  target.querySelectorAll('.ai-error-notice').forEach((n) => n.remove())
  const retryable = err?.retryable !== false
  const title = AI_ERROR_TITLES[err?.code] || 'Something went wrong'
  let wait = retryable ? Math.min(30, Math.max(0, Number(err?.retryAfter || 0))) : 0
  const btn = el('button', {
    type: 'button',
    class: 'ai-retry-btn inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-60'
  })
  const setLabel = () => {
    btn.innerHTML = wait > 0 ? `<i class="fas fa-hourglass-half"></i> Try again in ${wait}s` : '<i class="fas fa-rotate-right"></i> Try again'
    btn.disabled = wait > 0
  }
  setLabel()
  let timer = null
  if (wait > 0) timer = setInterval(() => { wait--; setLabel(); if (wait <= 0) clearInterval(timer) }, 1000)
  const box = el('div', { class: 'ai-error-notice fade-in mt-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 p-4', role: 'alert' },
    el('div', { class: 'flex items-start gap-3' },
      el('i', { class: 'fas ' + (retryable ? 'fa-triangle-exclamation' : 'fa-circle-exclamation') + ' text-amber-600 mt-0.5' }),
      el('div', { class: 'flex-1 min-w-0' },
        el('p', { class: 'font-semibold' }, title),
        el('p', { class: 'text-sm mt-0.5' }, err?.message || 'Please try again.'),
        retryable
          ? el('p', { class: 'text-xs mt-1 text-amber-700' }, 'Your text is kept. We already retried automatically across several AI models, so a short wait usually fixes this.')
          : null,
        el('div', { class: 'flex flex-wrap gap-2 mt-3' },
          retryable && onRetry ? btn : null,
          el('button', { type: 'button', class: 'text-sm px-3 py-2 rounded-lg border border-amber-300 hover:bg-amber-100', onclick: () => { clearInterval(timer); box.remove() } }, 'Dismiss')))))
  btn.onclick = () => { clearInterval(timer); box.remove(); onRetry && onRetry() }
  target.prepend(box)
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  return box
}

export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v !== null && v !== undefined) node.setAttribute(k, v)
  }
  children.flat().forEach((ch) => {
    if (ch == null) return
    node.append(ch.nodeType ? ch : document.createTextNode(ch))
  })
  return node
}

export const toast = (msg, type = 'info') => {
  const colors = {
    info: 'bg-slate-800',
    error: 'bg-red-500',
    success: 'bg-emerald-500'
  }
  const t = el('div', {
    class: `fixed top-4 left-1/2 -translate-x-1/2 z-50 text-white px-5 py-3 rounded-xl shadow-lg fade-in ${colors[type]}`
  }, msg)
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 3200)
}

// Extract plain text from a PDF file using pdf.js (loaded globally).
export async function pdfToText(file) {
  const pdfjsLib = window.pdfjsLib
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((it) => it.str).join(' ') + '\n\n'
  }
  return text.trim()
}

export const TYPE_LABELS = {
  multiple_choice: 'Multiple Choice',
  situational: 'Situational',
  true_false: 'True or False',
  identification: 'Identification'
}

// ---------------- BRANDING ----------------
export const BRAND = 'UNSTUDY'
// Logo: brand #4F46E5 app icon
export const logoImg = (size = 32, extra = '') =>
  el('img', { src: '/static/logo-192.png', alt: BRAND + ' logo', width: size, height: size, class: 'brand-logo rounded-lg ' + extra })
export const brandMark = (size = 30, textCls = 'text-indigo-600') =>
  el('span', { class: 'inline-flex items-center gap-2 font-extrabold tracking-wide ' + textCls },
    logoImg(size), el('span', {}, BRAND))

// ---------------- SHUFFLE ----------------
// Fisher–Yates shuffle (returns a new array)
export function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---------------- CLICK SOUND ----------------
// Plays /static/click.ogg (mp3 fallback for Safari/iOS) on every button click.
;(function setupClickSound() {
  if (window.__clickSound) return
  window.__clickSound = true
  const probe = document.createElement('audio')
  const src = probe.canPlayType('audio/ogg; codecs="vorbis"') ? '/static/click.ogg' : '/static/click.mp3'
  let ctx = null, buffer = null, loading = null
  const fallback = new Audio(src)
  fallback.preload = 'auto'
  function load() {
    if (loading) return loading
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return (loading = Promise.resolve())
    ctx = new AC()
    loading = fetch(src).then((r) => r.arrayBuffer())
      .then((b) => new Promise((res, rej) => ctx.decodeAudioData(b, res, rej)))
      .then((buf) => { buffer = buf })
      .catch(() => { ctx = null })
    return loading
  }
  function play() {
    try {
      if (ctx && buffer) {
        if (ctx.state === 'suspended') ctx.resume()
        const s = ctx.createBufferSource()
        s.buffer = buffer
        s.connect(ctx.destination)
        s.start(0)
      } else {
        const a = fallback.cloneNode()
        a.play().catch(() => {})
        load()
      }
    } catch (e) {}
  }
  const CLICKABLE = 'button, a[href], [role="button"], input[type="radio"], input[type="checkbox"], input[type="submit"], .clickable'
  document.addEventListener('pointerdown', () => load(), { once: true, capture: true })
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest(CLICKABLE) : null
    if (t && !t.disabled) play()
  }, true)
})()
