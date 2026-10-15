// Live game player page: /game/:code  (or /game to type a code)
// Flow: enter name (guests only — logged-in Unstudy users join with their
// username) → waiting room (countdown to the scheduled start) →
// black fade transition → quiz (3, 2, 1, Answer! only before the first question,
// then every answer auto-advances with a fade) → results + live ranking +
// review of every question/answer. No account required.
import { api, el, toast, logoImg, playJoinSoundFor, markJoinAnnounced } from './common.js'

const root = document.getElementById('root')
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
let code = (location.pathname.split('/').filter(Boolean)[1] || '').toUpperCase().replace(/[^A-Z]/g, '')
const tokenKey = () => 'game_token_' + code
let token = null
let state = null          // last /api/game/play response
let skew = 0              // server time - local time
let pollTimer = null
let tickTimer = null
let phase = null          // 'name' | 'waiting' | 'quiz' | 'done' | 'closed'
let qIndex = 0
let local = {}            // index -> { chosen, correct, answer, explanation }
let countdownDone = false // 3, 2, 1 is shown only once (before the first question)
let knownPlayers = null   // Set of player ids already seen (for the join sound)
let navSeq = 0            // bumps on every question render (cancels a pending auto-next)

// ---------------- JOIN SOUND ----------------
// /static/joingame.mp3 plays ONCE when a player joins the room.
// The shared helper (common.js) remembers every player id it already announced,
// so the same join can never trigger the sound twice (own join + the next
// poll, re-renders, a second tab, ...).
// The joining player hears it once right after pressing Join.
function joinSound(id) { playJoinSoundFor(code, [id == null ? 'self-' + Date.now() : id]) }
// Compare the player list with the last one we saw → play the sound once for new players.
function checkNewPlayers(list) {
  const ids = (list || []).map((p) => p.id)
  if (!knownPlayers) {
    // first list we see: these players were already here → never announce them
    ids.forEach((id) => markJoinAnnounced(code, id))
  } else {
    const fresh = ids.filter((id) => !knownPlayers.has(id))
    if (fresh.length) playJoinSoundFor(code, fresh)
  }
  knownPlayers = new Set(ids)
}

const serverNow = () => Date.now() + skew
const esc = (s) => String(s ?? '')

async function playApi(path, opts = {}) {
  return api(path, { ...opts, headers: { 'X-Player-Token': token || '', ...(opts.headers || {}) } })
}

function fmtCountdown(ms) {
  if (ms <= 0) return '0:00'
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const p = (n) => String(n).padStart(2, '0')
  if (d) return `${d}d ${h}h ${p(m)}m`
  if (h) return `${h}:${p(m)}:${p(sec)}`
  return `${m}:${p(sec)}`
}
const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

// ---------------- PER-STUDENT TIMER ----------------
// Every student has their OWN timer. It starts when they enter the live quiz
// (not in the waiting room) — so late joiners get the full time too.
// time_limit = 0 → no limit, the timer simply counts up (time spent).
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}
const fmtLimit = (sec) => { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m} min` }
const hasLimit = () => !!(state && state.room.time_limit)
// personal end = own deadline, but never later than the room closing time
const myEnd = () => (state.me.deadline ? Math.min(state.me.deadline, state.room.end_at) : null)
// While the connection is weak the timer is FROZEN at the moment it became weak.
const timerNow = () => (net.paused && net.pauseAt ? net.pauseAt : serverNow())
function timerText() {
  const now = timerNow()
  if (!state.me.started_at) return hasLimit() ? fmtClock(state.room.time_limit * 1000) : '00:00'
  if (hasLimit()) return fmtClock(myEnd() - now)
  return fmtClock(now - state.me.started_at - (state.me.paused_ms || 0))
}
function timerChip() {
  const chip = el('span', { id: 'player-timer', class: 'player-timer inline-flex items-center gap-1.5 font-mono font-bold tabular-nums px-3 py-1 rounded-full bg-white/15 text-white' },
    el('i', { class: 'fas ' + (hasLimit() ? 'fa-hourglass-half' : 'fa-stopwatch') }), el('span', { class: 'player-timer-val' }, timerText()))
  chip.title = hasLimit() ? 'Your time left' : 'Your time'
  return chip
}
function paintTimer() {
  const chip = document.getElementById('player-timer')
  if (!chip) return
  chip.querySelector('.player-timer-val').textContent = timerText()
  chip.classList.toggle('timer-paused', !!net.paused)
  const ic = chip.querySelector('i')
  if (ic) ic.className = 'fas ' + (net.paused ? 'fa-pause' : hasLimit() ? 'fa-hourglass-half' : 'fa-stopwatch')
  chip.title = net.paused ? 'Timer paused — weak connection' : hasLimit() ? 'Your time left' : 'Your time'
  if (hasLimit()) {
    const left = myEnd() - timerNow()
    chip.classList.toggle('timer-warn', !net.paused && left <= 60000 && left > 15000)
    chip.classList.toggle('timer-danger', !net.paused && left <= 15000)
  }
}
const myTimeUp = () => hasLimit() && state.me.started_at && !net.paused && myEnd() - serverNow() <= 0

// ================= 📶 NETWORK: PING + WIFI / DATA =================
// Every 3s the page measures its round-trip time to the server (ms) and reports
// it with the connection type (Wi-Fi or mobile data). If the connection is WEAK
// (ping >= LAG_PING ms) or offline, the player's timer is PAUSED until it recovers
// (max 5 minutes in total per player — enforced on the server).
const LAG_PING = 500
const MAX_PAUSE = 5 * 60000
const net = {
  ping: null, type: 'unknown', online: navigator.onLine !== false,
  paused: false, pauseAt: 0, offlineSince: 0, capReached: false,
  timer: null, running: false, busy: false
}
function connType() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  const t = c && c.type
  if (t === 'wifi' || t === 'wimax') return 'wifi'
  if (t === 'cellular') return 'cellular'
  if (t === 'ethernet') return 'ethernet'
  if (t === 'none') return 'unknown'
  // type not reported (e.g. iPhone / desktop browsers): best guess
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  if (c && c.saveData && mobile) return 'cellular'
  return mobile ? 'unknown' : 'wifi'
}
const netLevel = () => (!net.online ? 'off' : net.ping == null ? 'wait' : net.ping < 150 ? 'good' : net.ping < LAG_PING ? 'fair' : 'bad')
function netIconClass(type) {
  if (!net.online) return 'fa-plane'           // offline
  if (type === 'cellular') return 'fa-signal'  // mobile data
  if (type === 'ethernet') return 'fa-ethernet'
  return 'fa-wifi'
}
const netTypeLabel = (t) => (t === 'cellular' ? 'Mobile data' : t === 'ethernet' ? 'Ethernet' : t === 'wifi' ? 'Wi-Fi' : 'Network')
function netChip() {
  const chip = el('span', { id: 'net-chip', class: 'net-chip inline-flex items-center gap-1.5 font-mono font-bold tabular-nums px-2.5 py-1 rounded-full text-xs' },
    el('i', { class: 'fas fa-wifi net-chip-icon' }), el('span', { class: 'net-chip-ms' }, '-- ms'))
  paintNet(chip)
  return chip
}
function paintNet(chip = document.getElementById('net-chip')) {
  if (!chip) return
  const lvl = netLevel()
  chip.className = 'net-chip inline-flex items-center gap-1.5 font-mono font-bold tabular-nums px-2.5 py-1 rounded-full text-xs net-' + lvl
  chip.querySelector('.net-chip-icon').className = 'fas ' + netIconClass(net.type) + ' net-chip-icon'
  chip.querySelector('.net-chip-ms').textContent = !net.online ? 'Offline' : net.ping == null ? '-- ms' : net.ping + ' ms'
  chip.title = (net.online ? netTypeLabel(net.type) + ' · ping ' + (net.ping == null ? '…' : net.ping + ' ms') : 'You are offline') +
    (net.paused ? ' · weak connection, your timer is paused' : '')
  const banner = document.getElementById('net-pause-banner')
  if (banner) {
    banner.classList.toggle('hidden', !net.paused && !net.capReached)
    banner.textContent = net.paused
      ? (net.online ? `⏸ Weak connection (${net.ping} ms) — your timer is paused until it gets better.` : '⏸ You are offline — your timer is paused until you reconnect.')
      : net.capReached ? 'Pause limit reached (5 min) — the timer keeps running.' : ''
  }
}
async function measurePing() {
  const t0 = performance.now()
  const ctrl = new AbortController()
  const kill = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch('/api/game/ping?t=' + Date.now(), { cache: 'no-store', signal: ctrl.signal })
    await r.text()
    return Math.round(performance.now() - t0)
  } finally { clearTimeout(kill) }
}
// is the player answering right now? (timer running, quiz not stopped)
const answeringNow = () => phase === 'quiz' && state && state.me && state.me.started_at && !state.me.finished && state.room.status === 'live'
function setPaused(on) {
  const want = !!on && answeringNow() && !net.capReached && isIn()
  if (want === net.paused) return
  if (want) {
    net.paused = true; net.pauseAt = serverNow()
    net.snapDeadline = state.me.deadline; net.snapPaused = state.me.paused_ms || 0
  } else {
    // resume: push the local deadline back by the paused time (server confirms on the next heartbeat)
    const d = Math.max(0, serverNow() - net.pauseAt)
    if (state && state.me) {
      state.me.deadline = net.snapDeadline ? net.snapDeadline + d : state.me.deadline
      state.me.paused_ms = (net.snapPaused || 0) + d
    }
    net.paused = false; net.pauseAt = 0
  }
  paintTimer(); paintNet()
}
async function netBeat() {
  if (!net.running || net.busy) return
  net.busy = true
  net.type = connType()
  net.online = navigator.onLine !== false
  let ping = null
  try { ping = await measurePing(); net.online = true } catch (e) { net.online = false }
  if (net.online) {
    net.ping = ping
    const offline_ms = net.offlineSince ? Date.now() - net.offlineSince : 0
    try {
      const r = await playApi(`/api/game/play/${code}/heartbeat`, { method: 'POST', body: JSON.stringify({ ping_ms: ping, net_type: net.type, visible: isIn(), offline_ms }) })
      net.offlineSince = 0
      flushActivityQueue()
      if (state && state.me && !net.paused) {
        if (r.deadline) state.me.deadline = r.deadline
        if (r.paused_ms != null) state.me.paused_ms = r.paused_ms
      }
      net.capReached = (r.paused_ms || 0) >= (r.max_pause_ms || MAX_PAUSE)
      if (r.activity) myActivity = r.activity
    } catch (e) { if (e.code === 'network') net.online = false }
  }
  if (!net.online && !net.offlineSince) net.offlineSince = Date.now()
  setPaused(!net.online || (net.ping != null && net.ping >= LAG_PING))
  paintNet()
  net.busy = false
}
function startNet() {
  if (net.running) return
  net.running = true
  netBeat()
  net.timer = setInterval(netBeat, 3000)
  window.addEventListener('online', netBeat)
  window.addEventListener('offline', () => { net.online = false; if (!net.offlineSince) net.offlineSince = Date.now(); setPaused(true); paintNet() })
  const c = navigator.connection
  if (c && c.addEventListener) c.addEventListener('change', () => { net.type = connType(); paintNet() })
}
function stopNet() {
  if (!net.running) return
  net.running = false
  clearInterval(net.timer); net.timer = null
  setPaused(false)
}

// ================= 📋 ACTIVITY LOG: IN / OUT (anti-cheat) =================
// While the player is answering, every time they LEAVE the app/tab ("out") and
// COME BACK ("in") is recorded with a timestamp. Leaving often (10+ times) or for
// a long time (60s+) marks them as SUSPICIOUS (e.g. asking an AI for answers).
// Only the host can see the log (players do not see it). It stops when the quiz stops.
let myActivity = { log: [], away_count: 0, away_ms: 0, suspicious: false, recording: false }
let lastSent = null
let actQueue = []
let actCheck = null
const isIn = () => !document.hidden && document.hasFocus()
function sendActivity(type) {
  if (lastSent === type) return
  lastSent = type
  const at = serverNow()
  // show it right away in the local log
  const last = myActivity.log[myActivity.log.length - 1]
  if (!last || last.t !== type) {
    myActivity.log.push({ t: type, at })
    if (type === 'out') myActivity.away_count++
    else if (last && last.t === 'out') myActivity.away_ms += Math.max(0, at - last.at)
    myActivity.suspicious = myActivity.away_count >= 10 || myActivity.away_ms >= 60000
  }
  const body = JSON.stringify({ type, at, token })
  const url = `/api/game/play/${code}/activity`
  if (type === 'out' && navigator.sendBeacon) {
    // sendBeacon survives the page being hidden / closed
    try { if (navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return } catch (e) {}
  }
  fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Player-Token': token || '' }, body })
    .then((r) => { if (!r.ok && r.status >= 500) actQueue.push(body) })
    .catch(() => actQueue.push(body)) // offline → retry later with the original time
}
function flushActivityQueue() {
  const q = actQueue; actQueue = []
  q.forEach((body) => fetch(`/api/game/play/${code}/activity`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Player-Token': token || '' }, body }).catch(() => actQueue.push(body)))
}
let actDebounce = null
function onFocusChange() {
  if (!answeringNow()) return
  clearTimeout(actDebounce)
  const now = isIn() ? 'in' : 'out'
  // leaving is recorded immediately, coming back after a tiny debounce (avoids flicker)
  if (now === 'out') { sendActivity('out'); setPaused(false) }
  else actDebounce = setTimeout(() => { if (isIn()) sendActivity('in') }, 150)
}
// closing / reloading the page while answering also counts as leaving the app
function onPageHide() { if (answeringNow()) sendActivity('out') }
function startActivity() {
  if (actCheck) return
  lastSent = myActivity.log.length ? myActivity.log[myActivity.log.length - 1].t : null
  document.addEventListener('visibilitychange', onFocusChange)
  window.addEventListener('blur', onFocusChange)
  window.addEventListener('focus', onFocusChange)
  window.addEventListener('pagehide', onPageHide)
  // safety net: some phones don't fire events reliably
  actCheck = setInterval(onFocusChange, 1000)
  if (lastSent !== (isIn() ? 'in' : 'out')) onFocusChange()
}
function stopActivity() {
  if (!actCheck) return
  clearInterval(actCheck); actCheck = null
  document.removeEventListener('visibilitychange', onFocusChange)
  window.removeEventListener('blur', onFocusChange)
  window.removeEventListener('focus', onFocusChange)
  window.removeEventListener('pagehide', onPageHide)
  myActivity.recording = false
}
function shell(...children) {
  return el('div', { class: 'game-page min-h-screen flex flex-col' },
    el('header', { class: 'px-4 py-3 flex items-center justify-between max-w-2xl w-full mx-auto' },
      el('a', { href: '/app', class: 'flex items-center gap-2 font-extrabold tracking-wide text-white' }, logoImg(28), 'UNSTUDY'),
      code ? el('span', { class: 'font-mono text-sm font-bold tracking-widest bg-white/15 text-white px-3 py-1 rounded-full' }, code) : null),
    el('main', { class: 'flex-1 max-w-2xl w-full mx-auto px-4 pb-10 flex flex-col' }, ...children))
}
function show(...children) {
  root.innerHTML = ''
  root.appendChild(shell(...children))
}
function stopTimers() { clearTimeout(pollTimer); clearInterval(tickTimer); pollTimer = null; tickTimer = null }

function messageCard(icon, title, text, extra) {
  return el('div', { class: 'game-card rounded-3xl p-8 text-center my-auto fade-in' },
    el('i', { class: 'fas ' + icon + ' text-4xl mb-3 text-indigo-500' }),
    el('h1', { class: 'text-xl font-bold mb-1' }, title),
    el('p', { class: 'text-sm game-muted mb-5' }, text),
    extra || el('a', { href: '/game', class: 'inline-block px-5 py-2.5 rounded-full bg-indigo-600 text-white text-sm font-semibold' }, 'Enter another code'))
}

// ---------------- BOOT ----------------
async function boot() {
  if (!code) return codeScreen()
  token = localStorage.getItem(tokenKey())
  show(el('p', { class: 'text-white/80 text-center my-auto' }, el('span', { class: 'spinner' }), ' Loading room...'))
  if (token) {
    try {
      await refresh()
      // A guest who just logged in / created an account → link this game to the
      // account (saved in their history, unlocks the leaderboard + review).
      if (state.me.guest && localStorage.getItem('token') && localStorage.getItem('role') === 'user') {
        try {
          const cl = await playApi(`/api/game/play/${code}/claim`, { method: 'POST', body: '{}' })
          if (cl.token && cl.token !== token) { token = cl.token; localStorage.setItem(tokenKey(), token); local = {} }
          await refresh()
          if (cl.claimed) toast('Saved to your account! The leaderboard is unlocked.', 'success')
        } catch (e) { /* stay as guest */ }
      }
      return route(true)
    }
    catch (e) {
      if (e.status !== 403) return show(messageCard('fa-triangle-exclamation', 'Room not found', e.message))
      localStorage.removeItem(tokenKey()); token = null
    }
  }
  // Logged in to Unstudy? → join with the username, no name needed.
  let account = null
  if (localStorage.getItem('token')) {
    try { account = (await api('/api/game/whoami')).user } catch (e) { account = null }
  }
  if (account) {
    try {
      const r = await api('/api/game/join/' + code, { method: 'POST', body: '{}' })
      token = r.token
      localStorage.setItem(tokenKey(), token)
      if (!r.rejoined) joinSound(r.id); else markJoinAnnounced(code, r.id)
      await refresh()
      return route(true)
    } catch (e) {
      if (e.status === 410) return show(messageCard('fa-lock', 'This room is closed', e.message))
      if (e.status === 409) return show(messageCard('fa-screwdriver-wrench', 'Room not ready yet', e.message))
      return show(messageCard('fa-triangle-exclamation', 'Room not found', e.message))
    }
  }
  try {
    const { room } = await api('/api/game/join/' + code)
    skew = room.now - Date.now()
    if (room.status === 'closed') return show(messageCard('fa-lock', 'This room is closed', `"${room.title}" has already ended.`))
    nameScreen(room)
  } catch (e) {
    show(messageCard(e.status === 409 ? 'fa-screwdriver-wrench' : 'fa-triangle-exclamation', e.status === 409 ? 'Room not ready yet' : 'Room not found', e.message))
  }
}

async function refresh() {
  const t0 = Date.now()
  state = await playApi('/api/game/play/' + code)
  skew = state.room.now - Math.round((t0 + Date.now()) / 2)
  if (state.answers) Object.assign(local, state.answers)
  if (state.me && state.me.activity) {
    // keep any local events the server does not know about yet (offline queue)
    if (!actQueue.length) myActivity = state.me.activity
  }
  if (state.me && net.paused) {
    // timer is frozen locally — keep the values we had when it froze
    state.me.deadline = net.snapDeadline
    state.me.paused_ms = net.snapPaused
  }
  if (state.players) checkNewPlayers(state.players)
  return state
}

function route(initial = false) {
  const st = state.room.status
  if (st === 'closed') return finalScreen()
  if (st === 'scheduled') return waitingRoom()
  if (st === 'live') {
    const total = state.questions.length
    const firstOpen = state.questions.findIndex((q) => !local[q.i])
    if (firstOpen === -1 || state.me.timed_out || state.me.finished) return doneScreen()
    qIndex = firstOpen
    if (Object.keys(local).length) countdownDone = true // already started earlier
    // joining / reloading while live → still use the black fade
    return fadeToQuiz(initial)
  }
  show(messageCard('fa-screwdriver-wrench', 'Room not ready yet', 'The host is still setting up this room.'))
}

// ---------------- CODE ----------------
function codeScreen() {
  const input = el('input', { id: 'game-code', class: 'game-input text-center text-3xl font-extrabold tracking-[0.4em] uppercase', placeholder: 'CODE', maxlength: '12', autocomplete: 'off' })
  input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '') }
  const btn = el('button', { class: 'game-btn w-full mt-4' }, 'Enter')
  const go = () => {
    const v = input.value.trim()
    if (v.length < 4) return toast('Enter the room code', 'error')
    location.href = '/game/' + v
  }
  btn.onclick = go
  input.onkeydown = (e) => { if (e.key === 'Enter') go() }
  show(el('div', { class: 'game-card rounded-3xl p-8 my-auto fade-in' },
    el('h1', { class: 'text-2xl font-extrabold text-center mb-1' }, 'Join a game'),
    el('p', { class: 'text-sm game-muted text-center mb-5' }, 'Type the room code from your host.'),
    input, btn))
  setTimeout(() => input.focus(), 50)
}

// ---------------- NAME ----------------
function nameScreen(room) {
  const input = el('input', { id: 'player-name', class: 'game-input text-center text-xl font-bold', placeholder: 'Your name', maxlength: '24', autocomplete: 'nickname' })
  input.value = localStorage.getItem('game_name') || ''
  const err = el('p', { class: 'text-sm text-red-500 mt-2 min-h-[1.25rem] text-center' })
  const btn = el('button', { id: 'join-btn', 'data-no-click': '', class: 'game-btn w-full mt-2' }, el('i', { class: 'fas fa-right-to-bracket mr-2' }), 'Join')
  const go = async () => {
    err.textContent = ''
    const name = input.value.trim()
    if (name.length < 2) { err.textContent = 'Enter your name (at least 2 characters).'; return }
    btn.disabled = true
    try {
      const r = await api('/api/game/join/' + code, { method: 'POST', body: JSON.stringify({ name }) })
      token = r.token
      localStorage.setItem(tokenKey(), token)
      localStorage.setItem('game_name', name)
      joinSound(r.id)
      await refresh()
      route()
    } catch (e) { err.textContent = e.message; btn.disabled = false }
  }
  btn.onclick = go
  input.onkeydown = (e) => { if (e.key === 'Enter') go() }
  const live = room.status === 'live'
  show(el('div', { class: 'game-card rounded-3xl p-8 my-auto fade-in' },
    el('p', { class: 'text-xs uppercase tracking-widest text-center game-muted' }, 'You are joining'),
    el('h1', { class: 'text-2xl font-extrabold text-center mt-1 break-words' }, room.title),
    el('p', { class: 'text-sm text-center game-muted mt-1 mb-6' },
      `${room.total} questions · ` + (live ? 'The quiz has already started!' : 'Starts ' + fmtDateTime(room.start_at))),
    room.time_limit ? el('p', { class: 'text-xs text-center game-muted -mt-4 mb-5' }, el('i', { class: 'fas fa-hourglass-half mr-1' }),
      `You get ${fmtLimit(room.time_limit)} to answer. Your timer starts when you enter the quiz.`) : null,
    el('label', { class: 'block text-sm font-semibold mb-2 text-center', for: 'player-name' }, 'Enter your name'),
    input, err, btn,
    el('p', { class: 'text-xs text-center game-muted mt-4' }, 'Have an Unstudy account? ',
      el('a', { id: 'name-login-link', href: '/?next=' + encodeURIComponent('/game/' + code), class: 'font-semibold text-indigo-600 underline' }, 'Log in'),
      ' to save this quiz and see the leaderboard.')))
  setTimeout(() => input.focus(), 50)
}

// ---------------- WAITING ROOM ----------------
function waitingRoom() {
  stopTimers()
  phase = 'waiting'
  const r = state.room
  const countdown = el('div', { id: 'waiting-countdown', class: 'text-5xl sm:text-6xl font-extrabold tabular-nums my-2' }, fmtCountdown(r.start_at - serverNow()))
  const playersBox = el('div', { id: 'waiting-players', class: 'flex flex-wrap gap-2 justify-center' })
  const countLbl = el('span', {}, '')
  const paintPlayers = () => {
    playersBox.innerHTML = ''
    countLbl.textContent = `${state.players.length} player${state.players.length === 1 ? '' : 's'} in the room`
    state.players.forEach((p) => playersBox.appendChild(el('span', {
      class: 'player-chip fade-in px-3 py-1.5 rounded-full text-sm font-semibold ' + (p.id === state.me.id ? 'bg-indigo-600 text-white' : 'bg-white/15 text-white')
    }, p.name + (p.id === state.me.id ? ' (you)' : ''))))
  }
  show(
    el('section', { id: 'waiting-room', class: 'text-center text-white my-auto py-8 fade-in' },
      el('div', { class: 'waiting-pulse w-20 h-20 mx-auto rounded-full bg-white/15 flex items-center justify-center mb-5' }, el('i', { class: 'fas fa-hourglass-half text-3xl' })),
      el('p', { class: 'text-xs uppercase tracking-widest opacity-75' }, 'Waiting room'),
      el('h1', { class: 'text-2xl sm:text-3xl font-extrabold mt-1 break-words' }, r.title),
      el('p', { class: 'text-sm opacity-80 mt-1' }, `Hi ${state.me.name}! The quiz starts in`),
      countdown,
      el('p', { class: 'text-xs opacity-70 ' + (r.time_limit ? 'mb-2' : 'mb-8') }, fmtDateTime(r.start_at) + ` · ${r.total} questions`),
      r.time_limit ? el('p', { id: 'waiting-timer-info', class: 'text-xs font-semibold mb-8 inline-flex items-center gap-1 bg-white/15 rounded-full px-3 py-1' },
        el('i', { class: 'fas fa-hourglass-half' }), `Timer: ${fmtLimit(r.time_limit)} each — it starts when the quiz begins, not now`) : null,
      el('p', { class: 'text-sm font-semibold mb-3 opacity-90' }, el('i', { class: 'fas fa-users mr-1' }), countLbl),
      playersBox,
      el('p', { class: 'text-xs opacity-60 mt-8' }, 'Keep this page open. The quiz will start automatically.')))
  paintPlayers()
  tickTimer = setInterval(() => {
    const left = r.start_at - serverNow()
    countdown.textContent = fmtCountdown(left)
    if (left <= 0) {
      stopTimers()
      refresh().then(() => {
        if (state.room.status === 'live') fadeToQuiz()
        else if (state.room.status === 'closed') finalScreen()
        else waitingRoom()
      }).catch(() => setTimeout(waitingRoom, 1500))
    }
  }, 250)
  // Poll fast (every 1s) while in the waiting room so the joingame.mp3
  // sound plays right when a new player joins — no noticeable delay.
  const poll = async () => {
    try {
      await refresh()
      if (phase !== 'waiting') return
      if (state.room.status !== 'scheduled') { stopTimers(); return route() }
      if (state.room.start_at !== r.start_at) return waitingRoom() // host changed schedule
      paintPlayers()
    } catch (e) {
      if (e.status === 403) { localStorage.removeItem(tokenKey()); return show(messageCard('fa-user-xmark', 'You were removed', 'The host removed you from this room.')) }
    }
    pollTimer = setTimeout(poll, 1000)
  }
  pollTimer = setTimeout(poll, 1000)
}

// ---------------- BLACK FADE TRANSITION ----------------
function fadeToQuiz() {
  stopTimers()
  phase = 'quiz'
  const overlay = el('div', { id: 'black-fade', class: 'black-fade' },
    el('p', { class: 'black-fade-text' }, state.room.title))
  document.body.appendChild(overlay)
  // fade to black → swap content behind → fade out
  requestAnimationFrame(() => overlay.classList.add('in'))
  setTimeout(() => {
    renderQuestion()
    overlay.classList.add('out')
    setTimeout(() => overlay.remove(), 900)
  }, 1600)
}

// ---------------- QUIZ ----------------
function closesLabel() {
  const left = state.room.end_at - serverNow()
  return left > 0 ? 'Closes in ' + fmtCountdown(left) : 'Closed'
}

function renderQuestion() {
  stopTimers()
  phase = 'quiz'
  const mySeq = ++navSeq
  const qs = state.questions
  const q = qs[qIndex]
  const total = qs.length
  const done = Object.keys(local).length
  const score = Object.values(local).filter((a) => a.correct).length
  const wrong = done - score
  const closeLbl = el('span', { id: 'quiz-close-timer' }, closesLabel())

  const head = el('div', { class: 'flex items-center justify-between gap-2 text-white text-sm mb-3' },
    el('span', { class: 'min-w-0' },
      el('span', { class: 'block font-semibold truncate' }, state.room.title),
      el('span', { class: 'block text-xs opacity-70' }, el('i', { class: 'fas fa-clock mr-1' }), closeLbl)),
    el('span', { class: 'flex items-center gap-1.5 shrink-0' }, netChip(), timerChip()))
  const pauseBanner = el('p', { id: 'net-pause-banner', class: 'net-pause-banner hidden text-xs font-semibold rounded-xl px-3 py-2 mb-3' }, '')
  const progress = el('div', { class: 'h-2 rounded-full bg-white/20 overflow-hidden mb-4' },
    el('div', { class: 'h-full bg-white rounded-full transition-all', style: `width:${(done / total) * 100}%` }))

  const card = el('section', { id: 'quiz-card', class: 'game-card rounded-3xl p-6 relative overflow-hidden q-fade' })
  card.appendChild(el('div', { class: 'flex items-center justify-between mb-3' },
    el('span', { class: 'text-sm font-bold text-indigo-600' }, `Question ${qIndex + 1} of ${total}`),
    el('span', { id: 'quiz-tally', class: 'flex items-center gap-2 text-sm font-bold' },
      el('span', { class: 'tally-ok' }, '✓ ' + score),
      el('span', { class: 'tally-bad' }, '✗ ' + wrong))))
  if (q.section) card.appendChild(el('p', { id: 'game-question-title', class: 'quiz-section-title inline-flex items-center gap-2 text-xs font-bold px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 mb-2 break-words' },
    el('i', { class: 'fas fa-bookmark' }), q.section))
  card.appendChild(el('h2', { class: 'text-lg font-bold mb-5 whitespace-pre-wrap break-words' }, q.question))

  const answerArea = el('div', { id: 'answer-area', class: 'answer-locked' })
  const feedback = el('div', { class: 'mt-4' })
  const nav = el('div', { class: 'mt-5 flex justify-end' })
  // Back / Next buttons below the choices — look at previous questions and the
  // answer you gave. Answering still auto-advances to the next question.
  // The Next button is HIDDEN until the current question is answered —
  // it only shows on questions that already have an answer (e.g. when the
  // player navigated back to review one).
  const isLast = qIndex === total - 1
  const allDone = () => qs.every((x) => local[x.i])
  const backBtn = el('button', {
    id: 'quiz-back-btn', type: 'button',
    class: 'quiz-nav-btn quiz-nav-back',
    disabled: qIndex === 0 ? 'disabled' : null,
    onclick: () => goTo(qIndex - 1)
  }, el('i', { class: 'fas fa-arrow-left mr-2' }), 'Back')
  const nextBtn = el('button', {
    id: 'quiz-next-btn', type: 'button',
    class: 'quiz-nav-btn quiz-nav-next',
    onclick: () => {
      if (!isLast) return goTo(qIndex + 1)
      if (allDone()) return leaveTo(() => doneScreen())
      const open = qs.findIndex((x) => !local[x.i])
      if (open !== -1) goTo(open)
    }
  }, isLast ? (allDone() ? 'Finish' : 'Next') : 'Next', el('i', { class: 'fas ' + (isLast && allDone() ? 'fa-flag-checkered' : 'fa-arrow-right') + ' ml-2' }))
  const updateNext = () => {
    // Hide Next entirely while the current question is still unanswered.
    if (!local[q.i]) { nextBtn.style.visibility = 'hidden'; nextBtn.disabled = true; return }
    nextBtn.style.visibility = 'visible'
    // last question: Next jumps to an unanswered one, or becomes Finish when all are answered
    const disabled = isLast && !allDone() && qs.findIndex((x) => !local[x.i]) === qIndex
    nextBtn.disabled = disabled
    if (isLast && allDone()) { nextBtn.innerHTML = ''; nextBtn.append('Finish', el('i', { class: 'fas fa-flag-checkered ml-2' })) }
  }
  updateNext()
  const qnav = el('nav', { id: 'quiz-nav', class: 'quiz-nav mt-5 flex items-center justify-between gap-3' }, backBtn,
    el('span', { class: 'text-xs game-muted' }, `${qIndex + 1} / ${total}`), nextBtn)
  const setNavLocked = (locked) => {
    backBtn.disabled = locked || qIndex === 0
    if (locked) nextBtn.disabled = true; else updateNext()
  }
  function leaveTo(fn) {
    navSeq++ // cancel any pending auto-next
    card.classList.add('q-fade-out')
    setTimeout(() => { if (phase === 'quiz') fn() }, 250)
  }
  function goTo(target) {
    if (target < 0 || target >= total || target === qIndex) return
    leaveTo(() => { qIndex = target; renderQuestion() })
  }
  card.append(answerArea, feedback, qnav, nav)

  const existing = local[q.i]
  const submit = async (value, btnEl) => {
    if (local[q.i] || answerArea.classList.contains('answer-locked')) return
    answerArea.classList.add('answer-locked')
    if (btnEl) btnEl.classList.add('chosen')
    try {
      const r = await playApi(`/api/game/play/${code}/answer`, { method: 'POST', body: JSON.stringify({ index: q.i, answer: value }) })
      local[q.i] = { chosen: value, correct: r.correct, answer: r.answer, explanation: r.explanation }
      paintAnswered()
      updateNext()
      goNext()
    } catch (e) {
      if (e.status === 410) { toast(e.message, 'error'); return finalScreenSoon() }
      if (e.code === 'time_up' || /time is up/i.test(e.message)) { toast("Time's up!", 'error'); return timeUpSoon() }
      toast(e.message, 'error')
      answerArea.classList.remove('answer-locked')
      if (btnEl) btnEl.classList.remove('chosen')
    }
  }

  const optionBtns = []
  if (q.type === 'identification') {
    const input = el('input', { id: 'ident-answer', class: 'game-input', placeholder: 'Type your answer...', autocomplete: 'off', disabled: 'disabled' })
    const send = el('button', { class: 'game-btn w-full mt-3', disabled: 'disabled' }, 'Submit answer')
    send.onclick = () => { if (!input.value.trim()) return toast('Type an answer first', 'error'); submit(input.value.trim()) }
    input.onkeydown = (e) => { if (e.key === 'Enter') send.click() }
    answerArea.append(input, send)
    answerArea._unlock = () => { input.disabled = false; send.disabled = false; input.focus() }
  } else {
    const grid = el('div', { class: 'grid gap-3 ' + (q.type === 'true_false' ? 'grid-cols-2' : 'grid-cols-1') })
    q.options.forEach((opt, oi) => {
      const b = el('button', { class: 'game-option text-left rounded-2xl border-2 px-4 py-3 flex items-center gap-3 font-medium' },
        el('span', { class: 'opt-letter w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-bold' }, q.type === 'true_false' ? (oi === 0 ? '✓' : '✕') : LETTERS[oi]),
        el('span', { class: 'flex-1 break-words' }, opt))
      b.dataset.value = opt
      b.onclick = () => submit(opt, b)
      optionBtns.push(b)
      grid.appendChild(b)
    })
    answerArea.appendChild(grid)
    answerArea._unlock = () => {}
  }

  function paintAnswered() {
    const a = local[q.i]
    answerArea.classList.add('answer-locked')
    answerArea.style.opacity = '1'; answerArea.style.filter = 'none'
    const n = (s) => String(s || '').trim().toLowerCase()
    optionBtns.forEach((b) => {
      if (n(b.dataset.value) === n(a.answer)) b.classList.add('is-correct')
      else if (n(b.dataset.value) === n(a.chosen)) b.classList.add('is-wrong')
      b.disabled = true
    })
    const inp = answerArea.querySelector('input'); if (inp) { inp.value = a.chosen; inp.disabled = true }
    const sb = answerArea.querySelector('button.game-btn'); if (sb) sb.remove()
    const okN = Object.values(local).filter((x) => x.correct).length
    const tally = document.getElementById('quiz-tally')
    if (tally) { tally.children[0].textContent = '✓ ' + okN; tally.children[1].textContent = '✗ ' + (Object.keys(local).length - okN) }
    feedback.innerHTML = ''
    feedback.appendChild(el('div', { class: 'answer-mark fade-in ' + (a.correct ? 'is-ok' : 'is-bad') },
      el('span', { class: 'answer-mark-icon' }, a.correct ? '✓' : '✗'),
      el('span', { class: 'answer-mark-text' }, a.correct ? 'Correct' : 'Wrong')))
    // your answer (+ the correct one when you missed it)
    feedback.appendChild(el('div', { class: 'quiz-your-answer text-sm mt-3 rounded-xl px-3 py-2 game-row' },
      el('p', {}, 'Your answer: ', el('b', { class: a.correct ? 'text-emerald-600' : 'text-red-600' }, esc(a.chosen))),
      a.correct ? null : el('p', {}, 'Correct answer: ', el('b', { class: 'text-emerald-600' }, esc(a.answer))),
      a.explanation ? el('p', { class: 'text-xs game-muted mt-1' }, el('i', { class: 'fas fa-lightbulb text-amber-400 mr-1' }), a.explanation) : null))
    nav.innerHTML = ''
  }

  // after answering → automatically go to the next question with a fade
  function goNext() {
    const next = qs.findIndex((x, i) => i > qIndex && !local[x.i])
    const anyOpen = qs.findIndex((x) => !local[x.i])
    const target = next !== -1 ? next : anyOpen
    setTimeout(() => {
      if (phase !== 'quiz' || mySeq !== navSeq) return // player pressed Back / Next meanwhile
      card.classList.add('q-fade-out')
      setTimeout(() => {
        if (phase !== 'quiz' || mySeq !== navSeq) return
        if (target === -1) doneScreen()
        else { qIndex = target; renderQuestion() }
      }, 350)
    }, 850)
  }
  answerArea._afterAnswer = goNext

  show(head, pauseBanner, progress, card)
  startNet()
  paintNet()
  if (state.me.started_at) startActivity()

  // Answered question opened with Back / Next → just show it (no auto-next)
  if (existing) { paintAnswered() } else if (countdownDone) {
    // no countdown after the first question — answers unlock right away
    answerArea.classList.remove('answer-locked')
    answerArea._unlock()
  } else {
    countdownDone = true
    // 3, 2, 1, Answer! — only before the first question.
    // The student's personal timer starts only AFTER this countdown ends.
    const cd = el('div', { id: 'answer-countdown', class: 'answer-countdown' }, el('span', { class: 'cd-num' }, '3'))
    card.appendChild(cd)
    setNavLocked(true)
    const steps = ['3', '2', '1', 'Answer!']
    let k = 0
    const stepFn = () => {
      if (phase !== 'quiz' || !document.body.contains(cd)) return
      k++
      if (k < steps.length) {
        cd.innerHTML = ''
        cd.appendChild(el('span', { class: 'cd-num' + (k === steps.length - 1 ? ' cd-go' : '') }, steps[k]))
        setTimeout(stepFn, k === steps.length - 1 ? 650 : 800)
      } else {
        cd.classList.add('cd-hide')
        setTimeout(() => cd.remove(), 300)
        setNavLocked(false)
        answerArea.classList.remove('answer-locked')
        answerArea._unlock()
        startMyTimer()
      }
    }
    setTimeout(stepFn, 800)
  }
  // reloaded / came back without the countdown but the timer never started
  if ((existing || countdownDone) && !document.getElementById('answer-countdown') && !state.me.started_at) startMyTimer()

  tickTimer = setInterval(() => {
    closeLbl.textContent = closesLabel()
    paintTimer()
    if (state.room.end_at - serverNow() <= 0) { stopTimers(); finalScreenSoon() }
    else if (myTimeUp()) { stopTimers(); timeUpSoon() }
  }, 250)
  paintTimer()
}

// ⏱ Tell the server the countdown is over → the personal timer starts NOW.
let startingTimer = false
async function startMyTimer() {
  if (state.me.started_at || startingTimer) return
  startingTimer = true
  const t0 = Date.now()
  // show the timer running immediately (server value replaces it below)
  state.me.started_at = serverNow()
  if (hasLimit()) state.me.deadline = state.me.started_at + state.room.time_limit * 1000
  try {
    const r = await playApi(`/api/game/play/${code}/start`, { method: 'POST', body: '{}' })
    skew = r.now - Math.round((t0 + Date.now()) / 2)
    if (r.started_at) state.me.started_at = r.started_at
    state.me.deadline = r.deadline || null
    if (r.activity) myActivity = r.activity
  } catch (e) { /* the server also starts the timer on the first answer */ }
  startingTimer = false
  startActivity()
  paintTimer()
}

// The student's own timer ran out → lock the quiz and show their results
function timeUpSoon() {
  stopTimers()
  stopQuizTracking()
  phase = 'timeup'
  answerLockAll()
  const overlay = el('div', { id: 'time-up-overlay', class: 'time-up-overlay fade-in' },
    el('div', { class: 'time-up-box' }, el('i', { class: 'fas fa-hourglass-end text-4xl mb-2' }), el('p', { class: 'text-3xl font-extrabold' }, "Time's up!")))
  document.body.appendChild(overlay)
  setTimeout(() => {
    refresh().catch(() => {}).finally(() => {
      overlay.remove()
      if (state.room.status === 'closed') finalScreen(); else doneScreen()
    })
  }, 1600)
}
function answerLockAll() {
  document.querySelectorAll('#answer-area button, #answer-area input, #quiz-nav button').forEach((b) => { b.disabled = true })
}

function finalScreenSoon() {
  refresh().then(() => finalScreen()).catch(() => finalScreen())
}

// ---------------- RESULTS / RANKING ----------------
function rankingList(board, meId, total) {
  const medal = ['🥇', '🥈', '🥉']
  const box = el('ol', { id: 'ranking-list', class: 'space-y-2' })
  board.forEach((p) => box.appendChild(el('li', {
    class: 'ranking-row flex items-center gap-3 rounded-2xl px-4 py-3 ' + (p.id === meId ? 'bg-indigo-600 text-white' : 'game-row')
  },
    el('span', { class: 'w-8 text-center font-extrabold' }, medal[p.rank - 1] || '#' + p.rank),
    el('span', { class: 'flex-1 min-w-0' },
      el('span', { class: 'block font-semibold truncate' }, p.name + (p.id === meId ? ' (you)' : '')),
      el('span', { class: 'block text-xs opacity-75' }, (p.timed_out ? "Time's up · " + `${p.answered}/${total} answered` : p.finished ? 'Finished' : `${p.answered}/${total} answered`) + (p.time_used ? ' · ⏱ ' + fmtClock(p.time_used) : ''))),
    el('span', { class: 'flex items-center gap-2 text-sm font-extrabold' },
      el('span', {}, '✓ ' + p.score), el('span', { class: 'opacity-80' }, '✗ ' + Math.max(0, p.answered - p.score))))))
  return box
}

// Review of every question: your answer vs the correct answer
function reviewList() {
  const items = state.review || []
  if (!items.length) return null
  const n = (s) => String(s ?? '').trim().toLowerCase()
  const wrongCount = items.filter((q) => !q.correct).length
  const box = el('section', { id: 'answer-review', class: 'game-card rounded-3xl p-5 mt-4' },
    el('h2', { class: 'font-bold mb-1' }, el('i', { class: 'fas fa-list-check text-indigo-600 mr-1' }), 'Review your answers'),
    el('p', { class: 'text-xs game-muted mb-4' }, wrongCount ? `You missed ${wrongCount} question${wrongCount === 1 ? '' : 's'}. Check the correct answers below.` : 'Perfect! You got every question right.'))
  items.forEach((q, k) => {
    const item = el('article', { class: 'review-item rounded-2xl border-2 p-4 mb-3 ' + (q.correct ? 'review-ok' : 'review-bad') },
      el('div', { class: 'flex items-start gap-3' },
        el('span', { class: 'review-badge shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-extrabold text-white ' + (q.correct ? 'bg-emerald-500' : 'bg-red-500') }, q.correct ? '✓' : '✗'),
        el('div', { class: 'flex-1 min-w-0' },
          el('p', { class: 'text-xs font-bold game-muted' }, `Question ${k + 1}` + (q.section ? ` · ${q.section}` : '')),
          el('p', { class: 'font-semibold whitespace-pre-wrap break-words' }, q.question))))
    const body = el('div', { class: 'mt-3 space-y-1.5' })
    if (q.options && q.options.length) {
      q.options.forEach((opt, oi) => {
        const isAns = n(opt) === n(q.answer)
        const isMine = q.chosen != null && n(opt) === n(q.chosen)
        body.appendChild(el('div', { class: 'review-opt text-sm rounded-xl px-3 py-2 flex items-center gap-2 ' + (isAns ? 'opt-ans' : isMine ? 'opt-mine-wrong' : 'game-row') },
          el('span', { class: 'font-bold w-5' }, q.type === 'true_false' ? '' : LETTERS[oi]),
          el('span', { class: 'flex-1 break-words' }, opt),
          isAns ? el('span', { class: 'text-xs font-bold' }, '✓ Correct') : isMine ? el('span', { class: 'text-xs font-bold' }, '✗ Your answer') : null,
          isAns && isMine ? el('span', { class: 'text-xs font-bold' }, '· Your answer') : null))
      })
    } else {
      body.appendChild(el('p', { class: 'text-sm' }, 'Your answer: ', el('b', { class: q.correct ? 'text-emerald-600' : 'text-red-600' }, q.skipped ? '(not answered)' : esc(q.chosen))))
      if (!q.correct) body.appendChild(el('p', { class: 'text-sm' }, 'Correct answer: ', el('b', { class: 'text-emerald-600' }, esc(q.answer))))
    }
    if (q.skipped && q.options) body.appendChild(el('p', { class: 'text-xs text-red-500 font-semibold' }, 'Not answered'))
    if (q.explanation) body.appendChild(el('p', { class: 'text-xs game-muted mt-2' }, el('i', { class: 'fas fa-lightbulb text-amber-400 mr-1' }), q.explanation))
    item.appendChild(body)
    box.appendChild(item)
  })
  return box
}

// Guests (no account): leaderboard + answer review are locked behind log in / sign up.
function lockedCard() {
  const next = encodeURIComponent('/game/' + code)
  return el('section', { id: 'locked-leaderboard', class: 'game-card rounded-3xl p-6 text-center' },
    el('div', { class: 'w-14 h-14 mx-auto rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center mb-3' }, el('i', { class: 'fas fa-lock text-2xl' })),
    el('h2', { class: 'font-extrabold text-lg' }, 'Leaderboard is locked'),
    el('p', { class: 'text-sm game-muted mt-1 mb-4' }, 'Log in or create a free Unstudy account to see the leaderboard and your rank. This quiz will be saved to your history. You can review your answers below.'),
    el('div', { class: 'blur-sm select-none pointer-events-none opacity-60 space-y-2 mb-5', 'aria-hidden': 'true' },
      ...[1, 2, 3].map((n) => el('div', { class: 'game-row rounded-2xl px-4 py-3 flex items-center gap-3' },
        el('span', { class: 'font-extrabold' }, ['🥇', '🥈', '🥉'][n - 1]), el('span', { class: 'flex-1 text-left font-semibold' }, '••••••••'), el('span', { class: 'font-bold' }, '✓ ?')))),
    el('div', { class: 'flex flex-col sm:flex-row gap-2' },
      el('a', { id: 'locked-login-btn', href: '/?next=' + next, class: 'game-btn flex-1' }, el('i', { class: 'fas fa-right-to-bracket mr-2' }), 'Log in'),
      el('a', { id: 'locked-signup-btn', href: '/?mode=signup&next=' + next, class: 'game-btn flex-1 !bg-emerald-600 hover:!bg-emerald-700', style: 'background:#059669' }, el('i', { class: 'fas fa-user-plus mr-2' }), 'Create an account')))
}

function resultsView(title, subtitle) {
  if (state.me.guest) return guestResultsView(title, subtitle)
  const total = state.room.total
  const meRow = (state.leaderboard || []).find((p) => p.id === state.me.id)
  const score = meRow ? meRow.score : state.me.score
  const rank = meRow ? meRow.rank : state.me.rank
  return el('div', { class: 'fade-in my-auto' },
    el('section', { class: 'text-center text-white py-6' },
      el('i', { class: 'fas fa-trophy text-5xl text-amber-300 mb-3' }),
      el('h1', { class: 'text-2xl font-extrabold' }, title),
      el('p', { class: 'text-sm opacity-80 mt-1' }, subtitle),
      el('div', { class: 'flex justify-center gap-3 mt-5' },
        el('div', { class: 'bg-white/15 rounded-2xl px-5 py-3' }, el('p', { class: 'text-xs opacity-75' }, 'Correct'), el('p', { id: 'my-score', class: 'text-2xl font-extrabold' }, `✓ ${score}/${total}`)),
        el('div', { class: 'bg-white/15 rounded-2xl px-5 py-3' }, el('p', { class: 'text-xs opacity-75' }, 'Wrong'), el('p', { id: 'my-wrong', class: 'text-2xl font-extrabold' }, `✗ ${Math.max(0, (meRow ? meRow.answered : state.me.answered) - score)}`)),
        el('div', { class: 'bg-white/15 rounded-2xl px-5 py-3' }, el('p', { class: 'text-xs opacity-75' }, 'Your rank'), el('p', { id: 'my-rank', class: 'text-2xl font-extrabold' }, rank ? '#' + rank : '—'))),
      el('p', { id: 'my-time', class: 'inline-flex items-center gap-1.5 mt-4 text-sm font-semibold bg-white/15 rounded-full px-4 py-1.5' },
        el('i', { class: 'fas fa-stopwatch' }), 'Your time: ' + fmtClock((meRow && meRow.time_used) || state.me.time_used || 0),
        state.room.time_limit ? ` / ${fmtLimit(state.room.time_limit)}` : '',
        state.me.timed_out ? el('span', { class: 'ml-1 text-amber-300' }, "· time's up") : null)),
    el('section', { class: 'game-card rounded-3xl p-5' },
      el('h2', { class: 'font-bold mb-1' }, el('i', { class: 'fas fa-ranking-star text-indigo-600 mr-1' }), 'Ranking'),
      el('p', { class: 'text-xs game-muted mb-3' }, 'Highest score first. Same score → whoever used less time.'),
      rankingList(state.leaderboard || [], state.me.id, total)),
    reviewList())
}

function guestResultsView(title, subtitle) {
  const total = state.room.total
  const score = Object.values(local).filter((a) => a.correct).length || state.me.score
  const answered = Math.max(Object.keys(local).length, state.me.answered)
  return el('div', { class: 'fade-in my-auto' },
    el('section', { class: 'text-center text-white py-6' },
      el('i', { class: 'fas fa-trophy text-5xl text-amber-300 mb-3' }),
      el('h1', { class: 'text-2xl font-extrabold' }, title),
      el('p', { class: 'text-sm opacity-80 mt-1' }, subtitle),
      el('div', { class: 'flex justify-center gap-3 mt-5' },
        el('div', { class: 'bg-white/15 rounded-2xl px-5 py-3' }, el('p', { class: 'text-xs opacity-75' }, 'Correct'), el('p', { id: 'my-score', class: 'text-2xl font-extrabold' }, `✓ ${score}/${total}`)),
        el('div', { class: 'bg-white/15 rounded-2xl px-5 py-3' }, el('p', { class: 'text-xs opacity-75' }, 'Wrong'), el('p', { id: 'my-wrong', class: 'text-2xl font-extrabold' }, `✗ ${Math.max(0, answered - score)}`)),
        el('div', { class: 'bg-white/15 rounded-2xl px-5 py-3' }, el('p', { class: 'text-xs opacity-75' }, 'Your rank'), el('p', { id: 'my-rank', class: 'text-2xl font-extrabold' }, el('i', { class: 'fas fa-lock text-xl' })))),
      el('p', { id: 'my-time', class: 'inline-flex items-center gap-1.5 mt-4 text-sm font-semibold bg-white/15 rounded-full px-4 py-1.5' },
        el('i', { class: 'fas fa-stopwatch' }), 'Your time: ' + fmtClock(state.me.time_used || 0),
        state.room.time_limit ? ` / ${fmtLimit(state.room.time_limit)}` : '',
        state.me.timed_out ? el('span', { class: 'ml-1 text-amber-300' }, "· time's up") : null)),
    lockedCard(),
    reviewList())
}

// The quiz stopped for this player → the activity log and ping stop too.
function stopQuizTracking() {
  if (state && state.me) state.me.finished = true
  stopActivity()
  stopNet()
  document.getElementById('net-pause-banner')?.remove()
}

function doneScreen() {
  stopTimers()
  stopQuizTracking()
  phase = 'done'
  const paint = () => { const y = window.scrollY; show(resultsView(state.me.timed_out ? "Time's up!" : 'You finished!', `"${state.room.title}" · the room closes ${fmtDateTime(state.room.end_at)}. Ranking updates live.`)); window.scrollTo(0, y) }
  paint()
  const poll = async () => {
    try {
      await refresh()
      if (phase !== 'done') return
      if (state.room.status === 'closed') return finalScreen()
      paint()
    } catch (e) {}
    pollTimer = setTimeout(poll, 4000)
  }
  refresh().then(() => { if (phase === 'done') paint() }).catch(() => {})
  pollTimer = setTimeout(poll, 4000)
}

function finalScreen() {
  stopTimers()
  stopQuizTracking()
  phase = 'closed'
  const paint = () => {
    const y = window.scrollY
    show(resultsView('Final ranking', `"${state.room.title}" has closed.`),
      el('div', { class: 'text-center mt-6' }, el('a', { href: '/app', class: 'inline-block px-6 py-3 rounded-full bg-white text-indigo-700 font-bold' }, 'Back to Unstudy')))
    window.scrollTo(0, y)
  }
  paint()
  // the host can re-open a closed room → continue where you left off
  const poll = async () => {
    try {
      await refresh()
      if (phase !== 'closed') return
      if (state.room.status !== 'closed') { toast('The host re-opened the room!', 'success'); return route() }
    } catch (e) {}
    pollTimer = setTimeout(poll, 5000)
  }
  pollTimer = setTimeout(poll, 5000)
}

boot()
