// Live game player page: /game/:code  (or /game to type a code)
// Flow: enter name (guests only — logged-in Unstudy users join with their
// username) → waiting room (countdown to the scheduled start) →
// black fade transition → quiz (3, 2, 1, Answer! only before the first question,
// then every answer auto-advances with a fade) → results + live ranking +
// review of every question/answer. No account required.
import { api, el, toast, logoImg } from './common.js'

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
// /static/joingame.mp3 plays every time a player joins the room.
const joinSound = (() => {
  const a = new Audio('/static/joingame.mp3')
  a.preload = 'auto'
  // unlock audio on the first interaction (mobile autoplay rules)
  const unlock = () => { a.muted = true; a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false }).catch(() => { a.muted = false }) }
  document.addEventListener('pointerdown', unlock, { once: true, capture: true })
  document.addEventListener('keydown', unlock, { once: true, capture: true })
  return () => { try { const c = a.cloneNode(); c.volume = 1; c.play().catch(() => {}) } catch (e) {} }
})()
// Compare the player list with the last one we saw → play the sound for new players.
function checkNewPlayers(list) {
  const ids = new Set((list || []).map((p) => p.id))
  if (knownPlayers) {
    let joined = false
    ids.forEach((id) => { if (!knownPlayers.has(id)) joined = true })
    if (joined) joinSound()
  }
  knownPlayers = ids
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
    try { await refresh(); return route(true) }
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
      if (!r.rejoined) joinSound()
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
    if (firstOpen === -1) return doneScreen()
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
  const btn = el('button', { id: 'join-btn', class: 'game-btn w-full mt-2' }, el('i', { class: 'fas fa-right-to-bracket mr-2' }), 'Join')
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
      joinSound()
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
    el('label', { class: 'block text-sm font-semibold mb-2 text-center', for: 'player-name' }, 'Enter your name'),
    input, err, btn))
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
      el('p', { class: 'text-xs opacity-70 mb-8' }, fmtDateTime(r.start_at) + ` · ${r.total} questions`),
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

  const head = el('div', { class: 'flex items-center justify-between text-white text-sm mb-3' },
    el('span', { class: 'font-semibold truncate pr-2' }, state.room.title),
    el('span', { class: 'shrink-0 opacity-80' }, el('i', { class: 'fas fa-clock mr-1' }), closeLbl))
  const progress = el('div', { class: 'h-2 rounded-full bg-white/20 overflow-hidden mb-4' },
    el('div', { class: 'h-full bg-white rounded-full transition-all', style: `width:${(done / total) * 100}%` }))

  const card = el('section', { id: 'quiz-card', class: 'game-card rounded-3xl p-6 relative overflow-hidden q-fade' })
  card.appendChild(el('div', { class: 'flex items-center justify-between mb-3' },
    el('span', { class: 'text-sm font-bold text-indigo-600' }, `Question ${qIndex + 1} of ${total}`),
    el('span', { id: 'quiz-tally', class: 'flex items-center gap-2 text-sm font-bold' },
      el('span', { class: 'tally-ok' }, '✓ ' + score),
      el('span', { class: 'tally-bad' }, '✗ ' + wrong))))
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

  show(head, progress, card)

  // Answered question opened with Back / Next → just show it (no auto-next)
  if (existing) { paintAnswered() } else if (countdownDone) {
    // no countdown after the first question — answers unlock right away
    answerArea.classList.remove('answer-locked')
    answerArea._unlock()
  } else {
    countdownDone = true
    // 3, 2, 1, Answer! — only before the first question
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
      }
    }
    setTimeout(stepFn, 800)
  }

  tickTimer = setInterval(() => {
    closeLbl.textContent = closesLabel()
    if (state.room.end_at - serverNow() <= 0) { stopTimers(); finalScreenSoon() }
  }, 1000)
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
      el('span', { class: 'block text-xs opacity-75' }, p.finished ? 'Finished' : `${p.answered}/${total} answered`)),
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
          el('p', { class: 'text-xs font-bold game-muted' }, `Question ${k + 1}`),
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

function resultsView(title, subtitle) {
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
        el('div', { class: 'bg-white/15 rounded-2xl px-5 py-3' }, el('p', { class: 'text-xs opacity-75' }, 'Your rank'), el('p', { id: 'my-rank', class: 'text-2xl font-extrabold' }, rank ? '#' + rank : '—')))),
    el('section', { class: 'game-card rounded-3xl p-5' },
      el('h2', { class: 'font-bold mb-1' }, el('i', { class: 'fas fa-ranking-star text-indigo-600 mr-1' }), 'Ranking'),
      el('p', { class: 'text-xs game-muted mb-3' }, 'Highest score first. Same score → whoever finished first.'),
      rankingList(state.leaderboard || [], state.me.id, total)),
    reviewList())
}

function doneScreen() {
  stopTimers()
  phase = 'done'
  const paint = () => { const y = window.scrollY; show(resultsView('You finished!', `"${state.room.title}" · the room closes ${fmtDateTime(state.room.end_at)}. Ranking updates live.`)); window.scrollTo(0, y) }
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
