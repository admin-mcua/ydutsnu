// Quiz-only page: /quiz/:slug
// - Layout follows the reference screenshot (progress slider, n/total, ✕ / ✓ pills,
//   "Question N", lettered options, Correct answer / Incorrect badges, Back + Next).
// - Title + "Give up" button (saves score, goes back home).
// - Back is always visible; answered questions stay answered and are locked.
// - Next appears only after the current question is answered.
// - Retaking the wrong answers = a new "Round".
// - Logged-in users' scores are saved (only the quiz creator can see the stats).
// - Guests (no account) can only answer the first 2 questions, then must log in / sign up.
import { api, el, toast, shuffle, logoImg } from './common.js'

const root = document.getElementById('root')
const slug = location.pathname.split('/').filter(Boolean).pop()
const norm = (s) => String(s || '').trim().toLowerCase()
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const DIFF = {
  easy: { label: 'Easy', cls: 'bg-emerald-100 text-emerald-800', icon: 'fa-seedling' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-800', icon: 'fa-gauge' },
  hard: { label: 'Hard', cls: 'bg-red-100 text-red-800', icon: 'fa-fire' }
}

let quiz = null           // server data
let loggedIn = false
let round = 1
let list = []             // questions in current round
let answers = []          // per-index { chosen, correct } for current round
let index = 0
let firstRound = null     // { correct, wrong, answered } — the score that's saved
let attemptId = null
let finished = false

const homeUrl = () => (loggedIn ? '/app' : '/')

async function boot() {
  root.innerHTML = '<div class="qz flex items-center justify-center"><p class="qz-muted py-20"><span class="spinner spinner-dark"></span> Loading quiz...</p></div>'
  try {
    quiz = await api('/api/share/quiz/' + slug)
    loggedIn = !!quiz.logged_in
    if (!loggedIn && localStorage.getItem('token')) {
      // stale token — clear so the user is treated as a guest
      localStorage.removeItem('token'); localStorage.removeItem('role')
    }
    // remember each question's position in the quiz (used when saving answers)
    quiz.questions.forEach((q, i) => { q._i = i })
    startRound(quiz.questions.slice(), 1)
  } catch (e) {
    root.innerHTML = ''
    root.appendChild(el('div', { class: 'qz flex flex-col items-center justify-center text-center p-6' },
      el('i', { class: 'fas fa-triangle-exclamation text-3xl mb-2 text-amber-500' }),
      el('p', { class: 'font-medium mb-4' }, 'This quiz could not be found.'),
      el('a', { href: '/app', class: 'px-5 py-2.5 rounded-full bg-indigo-600 text-white text-sm font-medium' }, 'Go home')))
  }
}

// Multiple choice / situational choices are shuffled EVERY time the quiz is
// taken (and again for each retake round). True/False keeps True, False order.
function withShuffledChoices(q) {
  const canShuffle = q.options && q.options.length > 1 && q.type !== 'true_false'
  return { ...q, options: canShuffle ? shuffle(q.options) : (q.options ? q.options.slice() : q.options) }
}

function startRound(qs, r) {
  round = r
  list = qs.map(withShuffledChoices)
  answers = new Array(qs.length).fill(null)
  index = 0
  finished = false
  renderQuestion()
}

// Total shown in the counter. In round 1 guests still see the real total.
const roundTotal = () => (round === 1 ? quiz.total : list.length)
const counts = () => {
  let c = 0, w = 0
  answers.forEach((a) => { if (a) (a.correct ? c++ : w++) })
  return { c, w, answered: c + w }
}

// ---------------- LAYOUT ----------------
function frame(content) {
  root.innerHTML = ''
  const d = DIFF[quiz.difficulty] || DIFF.medium
  const header = el('header', { class: 'max-w-xl mx-auto px-5 pt-4 flex items-start gap-3' },
    el('a', { href: homeUrl(), title: 'UNSTUDY', class: 'flex-none mt-0.5' }, logoImg(30)),
    el('div', { class: 'flex-1 min-w-0' },
      el('h1', { id: 'quiz-title', class: 'text-lg font-bold leading-tight break-words' }, quiz.title),
      el('div', { class: 'flex flex-wrap items-center gap-2 mt-1 text-xs qz-muted' },
        el('span', { class: 'inline-flex items-center gap-1 font-semibold px-2 py-0.5 rounded-full ' + d.cls },
          el('i', { class: 'fas ' + d.icon }), d.label),
        el('span', {}, 'by ' + quiz.creator),
        round > 1 ? el('span', { class: 'font-semibold px-2 py-0.5 rounded-full bg-indigo-600 text-white' }, 'Round ' + round) : null
      )
    ),
    quiz.is_creator ? el('a', {
      id: 'edit-quiz-btn', title: 'Edit quiz', href: '/app?edit_quiz=' + quiz.id,
      class: 'px-3 py-1.5 rounded-full text-sm font-semibold border border-amber-400 text-amber-600 hover:bg-amber-500 hover:text-white whitespace-nowrap'
    }, el('i', { class: 'fas fa-pen-to-square' }), el('span', { class: 'hidden sm:inline ml-1' }, 'Edit quiz')) : null,
    el('button', {
      id: 'share-btn', title: 'Share quiz', class: 'w-9 h-9 rounded-full flex items-center justify-center qz-muted hover:opacity-70',
      onclick: shareQuiz
    }, el('i', { class: 'fas fa-share-nodes' })),
    el('button', {
      id: 'give-up-btn', class: 'px-3 py-1.5 rounded-full text-sm font-semibold border border-red-400 text-red-500 hover:bg-red-500 hover:text-white',
      onclick: giveUp
    }, el('i', { class: 'fas fa-flag mr-1' }), 'Give up')
  )
  root.appendChild(el('div', { class: 'qz flex flex-col' }, header,
    el('main', { class: 'max-w-xl w-full mx-auto px-5 pb-8 flex-1 flex flex-col' }, content)))
}

// ---------------- QUESTION ----------------
function renderQuestion() {
  const q = list[index]
  const a = answers[index]
  const { c, w } = counts()
  const total = roundTotal()
  const pct = total > 1 ? (index / (total - 1)) * 100 : 100

  const top = el('div', { class: 'flex items-center gap-3 mt-6 mb-7' },
    el('div', { class: 'relative flex-1 h-1.5 rounded-full qz-track' },
      el('div', { class: 'absolute inset-y-0 left-0 rounded-full qz-fill', style: `width:${pct}%` }),
      el('div', { class: 'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full qz-knob', style: `left:${pct}%` })
    ),
    el('span', { class: 'text-base font-medium whitespace-nowrap' }, `${index + 1}/${total}`),
    el('span', { class: 'qz-pill-wrong flex items-center gap-1.5 text-sm font-semibold px-3 py-1 rounded-full' }, el('i', { class: 'fas fa-xmark' }), String(w)),
    el('span', { class: 'qz-pill-right flex items-center gap-1.5 text-sm font-semibold px-3 py-1 rounded-full' }, el('i', { class: 'fas fa-check' }), String(c))
  )

  const body = el('section', { id: 'question-card', class: 'fade-in' },
    q.section ? el('p', { id: 'question-title', class: 'quiz-section-title inline-flex items-center gap-2 text-sm font-bold px-3 py-1 rounded-full bg-indigo-600 text-white mb-3 break-words' },
      el('i', { class: 'fas fa-bookmark' }), q.section) : null,
    el('p', { class: 'font-semibold mb-3' }, (round > 1 ? `Round ${round} · ` : '') + `Question ${index + 1}`),
    el('p', { class: 'text-lg leading-relaxed mb-7' }, q.question)
  )

  const locked = !!a
  if (q.options && q.options.length) {
    const opts = el('div', { class: 'space-y-3' })
    q.options.forEach((opt, oi) => {
      const isAns = norm(opt) === norm(q.answer)
      const isChosen = a && norm(a.chosen) === norm(opt)
      const showCorrect = locked && isAns
      const showWrong = locked && isChosen && !isAns
      const card = el('button', {
        class: 'qz-opt qz-card w-full text-left rounded-2xl px-5 py-4 ' + (locked ? 'cursor-default' : 'cursor-pointer'),
        disabled: locked ? 'true' : null,
        onclick: () => choose(opt)
      })
      const row = el('div', { class: 'flex items-center gap-3 flex-wrap' },
        el('span', { class: (showCorrect || showWrong ? 'font-bold' : '') + ' min-w-[1.5rem]' }, LETTERS[oi] + '.'),
        el('span', { class: 'flex-1 ' + (showCorrect || showWrong ? 'font-bold' : '') }, opt,
          showWrong ? el('span', { class: 'ml-2 text-sm font-normal qz-muted' }, '(Your answer)') : null),
        showCorrect ? el('span', { class: 'qz-badge-right flex items-center gap-1.5 text-sm px-3 py-1 rounded-full whitespace-nowrap' }, el('i', { class: 'fas fa-check' }), 'Correct answer') : null,
        showWrong ? el('span', { class: 'qz-badge-wrong flex items-center gap-1.5 text-sm px-3 py-1 rounded-full whitespace-nowrap' }, el('i', { class: 'fas fa-xmark' }), 'Incorrect') : null
      )
      card.appendChild(row)
      if (showCorrect && q.explanation) card.appendChild(el('p', { class: 'mt-2 leading-relaxed' }, q.explanation))
      if (showWrong) card.appendChild(el('p', { class: 'mt-2 leading-relaxed' }, `Not quite — the correct answer is "${q.answer}".`))
      opts.appendChild(card)
    })
    body.appendChild(opts)
  } else {
    // Identification (type the answer)
    const inp = el('input', {
      id: 'answer-input',
      class: 'qz-card flex-1 rounded-2xl px-5 py-4 text-base',
      placeholder: 'Type your answer'
    })
    if (locked) { inp.value = a.chosen; inp.disabled = true }
    const check = el('button', {
      class: 'px-5 rounded-2xl bg-indigo-600 text-white font-medium disabled:opacity-50',
      disabled: locked ? 'true' : null,
      onclick: () => { if (inp.value.trim()) choose(inp.value) }
    }, 'Check')
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim() && !locked) choose(inp.value) })
    body.appendChild(el('div', { class: 'flex gap-2' }, inp, check))
    if (locked) {
      body.appendChild(el('div', { class: 'qz-card rounded-2xl px-5 py-4 mt-3' },
        el('div', { class: 'flex items-center gap-2 mb-1' },
          a.correct
            ? el('span', { class: 'qz-badge-right flex items-center gap-1.5 text-sm px-3 py-1 rounded-full' }, el('i', { class: 'fas fa-check' }), 'Correct')
            : el('span', { class: 'qz-badge-wrong flex items-center gap-1.5 text-sm px-3 py-1 rounded-full' }, el('i', { class: 'fas fa-xmark' }), 'Incorrect')),
        a.correct ? null : el('p', { class: 'font-semibold mt-1' }, 'Correct answer: ' + q.answer),
        q.explanation ? el('p', { class: 'mt-1 leading-relaxed' }, q.explanation) : null
      ))
    }
    if (!locked) setTimeout(() => inp.focus(), 50)
  }

  // Bottom nav: Back always visible, Next only after answering
  const isLast = index === list.length - 1
  const backBtn = el('button', {
    id: 'back-btn',
    class: 'qz-back px-7 py-3.5 rounded-full text-base font-medium ' + (index === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'),
    onclick: () => { if (index > 0) { index--; renderQuestion() } }
  }, 'Back')
  const nav = el('nav', { class: 'mt-auto pt-10 flex items-center justify-center gap-3' }, backBtn)
  if (locked) {
    nav.appendChild(el('button', {
      id: 'next-btn',
      class: 'px-7 py-3.5 rounded-full text-base font-medium bg-blue-700 text-white hover:bg-blue-800',
      onclick: next
    }, isLast && (loggedIn || round > 1 || list.length >= quiz.total) ? 'Finish' : 'Next'))
  }

  frame(el('div', { class: 'flex flex-col flex-1' }, top, body, nav))
}

function choose(value) {
  if (answers[index]) return // answered questions cannot be changed
  const q = list[index]
  answers[index] = { chosen: value, correct: norm(value) === norm(q.answer) }
  renderQuestion()
}

function next() {
  // Guests: after the 2 free questions, require an account
  if (!loggedIn && round === 1 && index === list.length - 1 && list.length < quiz.total) {
    return showAuthGate()
  }
  if (index < list.length - 1) { index++; renderQuestion(); return }
  finishRound()
}

// ---------------- ROUND RESULTS ----------------
async function finishRound() {
  finished = true
  const { c, w, answered } = counts()
  if (round === 1) firstRound = { correct: c, wrong: w, answered, details: roundDetails() }
  const wrongQs = list.filter((_, i) => answers[i] && !answers[i].correct)
  await saveScore(wrongQs.length ? 'completed' : 'mastered')

  const total = list.length
  const pct = total ? Math.round((c / total) * 100) : 0
  const panel = el('section', { id: 'results', class: 'qz-card rounded-2xl p-6 text-center mt-8 fade-in' },
    el('i', { class: `fas fa-trophy text-4xl mb-3 ${pct >= 70 ? 'text-amber-400' : 'qz-muted'}` }),
    el('h2', { class: 'text-xl font-bold mb-1' }, round === 1 ? 'Quiz complete!' : `Round ${round} complete!`),
    el('p', { class: 'qz-muted' }, `You got ${c} of ${total} correct (${pct}%).`),
    round > 1 && firstRound ? el('p', { class: 'text-sm qz-muted mt-1' }, `Saved score (Round 1): ${firstRound.correct}/${quiz.total}`) : null,
    loggedIn ? el('p', { class: 'text-xs qz-muted mt-2' }, el('i', { class: 'fas fa-cloud-arrow-up mr-1' }), 'Your score has been saved.') : null
  )
  const actions = el('div', { class: 'mt-4 space-y-3' })
  if (wrongQs.length) {
    panel.appendChild(el('p', { class: 'text-sm mt-4' }, `You missed ${wrongQs.length} ${wrongQs.length === 1 ? 'question' : 'questions'}. Retake them in the next round.`))
    actions.appendChild(el('button', {
      id: 'next-round-btn',
      class: 'w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3.5 rounded-full flex items-center justify-center gap-2',
      onclick: () => startRound(wrongQs, round + 1)
    }, el('i', { class: 'fas fa-rotate-right' }), `Start Round ${round + 1} (${wrongQs.length} wrong)`))
  } else {
    panel.appendChild(el('p', { class: 'text-emerald-600 font-semibold mt-4' }, el('i', { class: 'fas fa-circle-check mr-1' }), 'Perfect — all answers correct!'))
  }
  actions.appendChild(el('button', {
    class: 'w-full qz-back font-medium py-3.5 rounded-full',
    onclick: () => { location.href = homeUrl() }
  }, el('i', { class: 'fas fa-house mr-2' }), 'Back to home'))

  frame(el('div', {}, panel, actions))
  // Hide Give up once everything is done
  if (!wrongQs.length) document.getElementById('give-up-btn')?.remove()
}

// Every answer of round 1 → saved so the quiz creator can review it in Stats
function roundDetails() {
  const out = []
  answers.forEach((a, i) => {
    if (!a) return
    const q = list[i]
    out.push({ i: q._i, chosen: a.chosen, correct: a.correct, options: q.options })
  })
  return out
}

async function saveScore(status) {
  if (!loggedIn) return
  try {
    const payload = {
      share_id: quiz.share_id, status, rounds: round, attempt_id: attemptId,
      ...(firstRound || { correct: 0, wrong: 0, answered: 0 })
    }
    const r = await api('/api/quiz/attempt', { method: 'POST', body: JSON.stringify(payload) })
    attemptId = r.attempt_id
  } catch (e) { toast('Could not save score: ' + e.message, 'error') }
}

// ---------------- GIVE UP ----------------
function giveUp() {
  confirmDialog('Give up this quiz?', loggedIn
    ? 'Your current score will be saved and you will go back home.'
    : 'You will go back to the home page.', 'Give up', async () => {
      // Save the score when giving up in the middle of a round
      if (loggedIn && !finished) {
        if (round === 1) {
          const { c, w, answered } = counts()
          firstRound = { correct: c, wrong: w, answered, details: roundDetails() }
        }
        await saveScore('gave_up')
      }
      location.href = homeUrl()
    })
}

// ---------------- GUEST GATE ----------------
function showAuthGate() {
  const next = encodeURIComponent('/quiz/' + slug)
  const overlay = el('div', { id: 'auth-gate', class: 'fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4' })
  overlay.appendChild(el('div', { class: 'bg-white text-gray-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center fade-in' },
    el('div', { class: 'w-14 h-14 mx-auto rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center mb-3' },
      el('i', { class: 'fas fa-lock text-xl' })),
    el('h2', { class: 'text-lg font-bold mb-1 text-gray-900' }, 'Log in to keep going'),
    el('p', { class: 'text-sm text-gray-700 mb-5' },
      `You've answered the ${quiz.guest_limit} free questions. Log in or create a free account to answer all ${quiz.total} questions and save your score.`),
    el('a', { href: `/?next=${next}`, class: 'block w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-full mb-2' }, 'Log in'),
    el('a', { href: `/?mode=signup&next=${next}`, class: 'block w-full border border-indigo-600 text-indigo-700 font-medium py-3 rounded-full mb-3' }, 'Sign up'),
    el('button', { class: 'text-sm text-gray-700 underline', onclick: () => overlay.remove() }, 'Not now')
  ))
  document.body.appendChild(overlay)
}

// ---------------- HELPERS ----------------
function shareQuiz() {
  const url = location.origin + '/quiz/' + slug
  if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) return navigator.share({ title: quiz.title, url }).catch(() => {})
  ;(navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
    .then(() => toast('Quiz link copied!', 'success'))
    .catch(() => prompt('Copy this link:', url))
}

function confirmDialog(title, text, okText, onOk) {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4' })
  const ok = el('button', { class: 'flex-1 bg-red-500 hover:bg-red-600 text-white font-medium py-2.5 rounded-full' }, okText)
  ok.onclick = async () => { ok.disabled = true; ok.innerHTML = '<span class="spinner"></span>'; await onOk() }
  overlay.appendChild(el('div', { class: 'bg-white text-gray-900 rounded-2xl shadow-2xl w-full max-w-sm p-6 fade-in' },
    el('h2', { class: 'text-lg font-bold mb-1 text-gray-900' }, title),
    el('p', { class: 'text-sm text-gray-700 mb-5' }, text),
    el('div', { class: 'flex gap-2' },
      el('button', { class: 'flex-1 bg-gray-200 text-gray-900 font-medium py-2.5 rounded-full', onclick: () => overlay.remove() }, 'Cancel'),
      ok)
  ))
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
}

boot()
