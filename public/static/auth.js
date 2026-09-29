import { api, el, toast, brandMark } from './common.js'

const root = document.getElementById('root')
let mode = 'login'

// Optional ?next=/quiz/xxxx so a guest who hit the quiz limit returns to it
const nextUrl = (() => {
  const n = new URLSearchParams(location.search).get('next') || ''
  return n.startsWith('/') && !n.startsWith('//') ? n : ''
})()
if (new URLSearchParams(location.search).get('mode') === 'signup') mode = 'signup'

if (localStorage.getItem('token') && localStorage.getItem('role') === 'user') {
  location.href = nextUrl || '/app'
}

function render() {
  root.innerHTML = ''
  root.appendChild(mode === 'login' ? loginView() : signupView())
}

function shell(title, subtitle, body) {
  return el('div', { class: 'min-h-screen flex items-center justify-center p-4 bg-slate-50' },
    el('div', { class: 'w-full max-w-md' },
      el('div', { class: 'text-center mb-6' },
        el('div', { class: 'inline-flex flex-col items-center gap-2' },
          brandMark(56, 'text-3xl text-indigo-600 flex-col')
        ),
        el('p', { class: 'text-slate-500 mt-1' }, 'Review lessons the smart way')
      ),
      el('div', { class: 'bg-white rounded-2xl shadow-xl p-7 fade-in' },
        el('h1', { class: 'text-xl font-bold mb-1 text-slate-800' }, title),
        el('p', { class: 'text-sm text-slate-500 mb-5' }, subtitle),
        body
      )
    )
  )
}

// ---------------- LOGIN ----------------
function loginView() {
  const username = el('input', { placeholder: 'Username or email', autocomplete: 'username', class: inputCls() })
  const pass = el('input', { type: 'password', placeholder: 'Password', class: inputCls() })
  const btn = el('button', { class: btnCls() }, 'Log in')

  btn.onclick = async () => {
    if (!username.value || !pass.value) return toast('Enter your username or email and password', 'error')
    setLoading(btn, true, 'Logging in...')
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: username.value.trim(), password: pass.value })
      })
      localStorage.setItem('token', data.token)
      localStorage.setItem('role', data.role || 'user')
      location.href = data.role === 'admin' ? '/admin' : (nextUrl || '/app')
    } catch (e) {
      toast(e.message, 'error')
      setLoading(btn, false, 'Log in')
    }
  }

  return shell('Welcome back', 'Log in to your account', el('div', {},
    field('Username or email', username), field('Password', passwordField(pass)), btn,
    el('p', { class: 'text-sm text-center text-slate-500 mt-4' },
      "Don't have an account? ",
      link('Sign up', () => { mode = 'signup'; render() })
    )
  ))
}

// ---------------- SIGNUP ----------------
function signupView() {
  const username = el('input', { placeholder: 'Username', class: inputCls() })
  const email = el('input', { type: 'email', placeholder: 'youremail@gmail.com', class: inputCls() })
  const pass = el('input', { type: 'password', placeholder: 'Password', class: inputCls() })
  const pass2 = el('input', { type: 'password', placeholder: 'Retype your password', class: inputCls() })

  const createBtn = el('button', { class: btnCls() }, 'Create account')

  createBtn.onclick = async () => {
    if (!username.value || !email.value || !pass.value)
      return toast('Fill in all fields', 'error')
    // Gmail-only validation
    if (!email.value.toLowerCase().endsWith('@gmail.com'))
      return toast('Only @gmail.com email addresses are allowed', 'error')
    if (pass.value !== pass2.value)
      return toast('Passwords do not match', 'error')
    if (pass.value.length < 4)
      return toast('Password too short', 'error')

    setLoading(createBtn, true, 'Creating...')
    try {
      const data = await api('/api/signup', {
        method: 'POST',
        body: JSON.stringify({
          username: username.value,
          email: email.value,
          password: pass.value,
          client: await collectClientInfo()
        })
      })
      localStorage.setItem('token', data.token)
      localStorage.setItem('role', 'user')
      location.href = nextUrl || '/app'
    } catch (e) {
      toast(e.message, 'error')
      setLoading(createBtn, false, 'Create account')
    }
  }

  return shell('Create your account', 'Sign up to save your flashcards & quizzes',
    el('div', {},
      field('Username', username),
      field('Email', email),
      field('Password', passwordField(pass)),
      field('Retype password', passwordField(pass2)),
      createBtn,
      el('p', { class: 'text-sm text-center text-slate-500 mt-4' },
        'Already have an account? ',
        link('Log in', () => { mode = 'login'; render() })
      )
    )
  )
}

// ---------------- DEVICE / SOFTWARE INFO ----------------
// Collected on sign-up and shown ONLY in the admin dashboard.
// ISP / carrier and location are detected on the server from the IP address.
async function collectClientInfo() {
  const info = {
    user_agent: navigator.userAgent,
    platform: navigator.platform || '',
    language: navigator.language || '',
    languages: (navigator.languages || []).join(', '),
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
    screen: `${screen.width}x${screen.height} @${window.devicePixelRatio || 1}x`,
    touch: navigator.maxTouchPoints > 0,
    cores: navigator.hardwareConcurrency || null,
    memory_gb: navigator.deviceMemory || null
  }
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (conn) {
    info.connection_type = conn.type || ''
    info.connection_effective = conn.effectiveType || ''
  }
  // High-entropy UA client hints (Chrome/Edge/Android) give exact OS + device model
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const h = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'model', 'fullVersionList', 'mobile'])
      info.ch_platform = h.platform || ''
      info.ch_platform_version = h.platformVersion || ''
      info.ch_model = h.model || ''
      info.ch_mobile = !!h.mobile
      info.ch_browsers = (h.fullVersionList || []).filter((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand)).map((b) => b.brand + ' ' + b.version).join(', ')
    }
  } catch (e) {}
  return info
}

// UI helpers
function passwordField(input) {
  input.type = 'password'
  input.classList.add('pr-11')
  const toggle = el('button', {
    type: 'button',
    class: 'absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600',
    'aria-label': 'Show password'
  }, el('i', { class: 'fas fa-eye' }))
  toggle.onclick = () => {
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    toggle.innerHTML = show ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>'
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password')
  }
  return el('div', { class: 'relative' }, input, toggle)
}

function inputCls() {
  return 'w-full border border-slate-300 rounded-lg px-3 py-2.5 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 text-slate-800'
}
function btnCls() {
  return 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-60'
}
function field(label, input) {
  return el('div', { class: 'mb-4' },
    el('label', { class: 'block text-sm font-medium text-slate-600 mb-1' }, label), input)
}
function link(text, onclick) {
  return el('button', { class: 'text-indigo-600 font-medium hover:underline', onclick }, text)
}
function setLoading(btn, loading, text) {
  btn.disabled = loading
  btn.innerHTML = loading ? `<span class="spinner"></span> ${text}` : text
}

render()
