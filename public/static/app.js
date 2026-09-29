import { api, el, toast, pdfToText, TYPE_LABELS, brandMark, showAiError } from './common.js'

const root = document.getElementById('root')

if (!localStorage.getItem('token') || localStorage.getItem('role') !== 'user') {
  location.href = '/'
}

let me = null
let view = 'home' // home | create | discover | profile | settings | user-profile
let sourceText = ''
let currentSet = null
let viewingUserId = null

// Theme helpers
function isDark() { return document.documentElement.classList.contains('dark') }
function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark')
    localStorage.setItem('theme', 'dark')
  } else {
    document.documentElement.classList.remove('dark')
    localStorage.setItem('theme', 'light')
  }
}

async function boot() {
  try {
    const data = await api('/api/me')
    me = data.user
    applyTheme(me.theme || 'light')
    render()
  } catch (e) {
    localStorage.clear()
    location.href = '/'
  }
}

function logout() {
  api('/api/logout', { method: 'POST' }).finally(() => {
    localStorage.clear()
    location.href = '/'
  })
}

function render() {
  root.innerHTML = ''
  root.appendChild(el('div', { class: 'min-h-screen flex flex-col pb-20' }, topBar(), mainContent()))
  root.appendChild(bottomNav())
}

// ================= TOP BAR =================
function topBar() {
  let title = 'UNSTUDY'
  const isMainTab = ['home', 'create', 'discover', 'profile'].includes(view)
  if (view === 'home') title = 'Home'
  else if (view === 'create') title = 'Create'
  else if (view === 'discover') title = 'Discover'
  else if (view === 'profile') title = 'Profile'
  else if (view === 'settings') title = 'Settings & Privacy'
  else if (view === 'edit-profile') title = 'Edit Profile'
  else if (view === 'user-profile') title = 'Profile'

  const friendReqBtn = el('button', {
    class: 'relative w-9 h-9 rounded-full flex items-center justify-center ' + dc('hover:bg-slate-100', 'hover:bg-gray-700'),
    onclick: () => showFriendRequests()
  }, el('i', { class: 'fas fa-user-plus text-sm' }))

  // Load friend request count
  api('/api/friends/requests').then(data => {
    if (data.requests && data.requests.length > 0) {
      const badge = el('span', {
        class: 'absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold'
      }, String(data.requests.length))
      friendReqBtn.appendChild(badge)
    }
  }).catch(() => {})

  return el('header', { class: 'sticky top-0 z-30 border-b ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('div', { class: 'max-w-2xl mx-auto px-4 py-3 flex items-center justify-between' },
      el('div', { class: 'flex items-center gap-2' },
        (view !== 'home' && view !== 'create' && view !== 'discover' && view !== 'profile')
          ? el('button', {
              class: 'w-9 h-9 rounded-full flex items-center justify-center ' + dc('hover:bg-slate-100', 'hover:bg-gray-700'),
              onclick: () => { view = 'profile'; render() }
            }, el('i', { class: 'fas fa-arrow-left' }))
          : null,
        isMainTab
          // Main tabs: brand name on top (like Facebook / Instagram)
          ? el('button', { id: 'brand-home', class: 'flex items-center', onclick: () => { view = 'home'; render() } },
              brandMark(32, 'text-2xl text-indigo-600'))
          : el('h1', { class: 'text-lg font-bold' }, title)
      ),
      el('div', { class: 'flex items-center gap-1' },
        friendReqBtn
      )
    )
  )
}

// ================= BOTTOM NAV (mobile style) =================
function bottomNav() {
  const items = [
    { id: 'home', icon: 'fa-house', label: 'Home' },
    { id: 'discover', icon: 'fa-compass', label: 'Discover' },
    { id: 'create', icon: 'fa-circle-plus', label: 'Create' },
    { id: 'profile', icon: 'fa-user', label: 'Profile' }
  ]

  const nav = el('nav', {
    class: 'fixed bottom-0 inset-x-0 z-40 border-t ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700')
  })

  const inner = el('div', { class: 'max-w-2xl mx-auto flex' })
  items.forEach(item => {
    const isActive = (view === item.id) || ((view === 'settings' || view === 'edit-profile') && item.id === 'profile') || (view === 'user-profile' && item.id === 'discover')
    const btn = el('button', {
      class: `flex-1 flex flex-col items-center py-2 text-xs gap-0.5 transition-colors ${
        isActive ? 'text-indigo-600' : dc('text-slate-500 hover:text-slate-700', 'text-gray-400 hover:text-gray-200')
      }`,
      onclick: () => { view = item.id; render() }
    },
      el('i', { class: `fas ${item.icon} text-lg` }),
      el('span', {}, item.label)
    )
    inner.appendChild(btn)
  })
  nav.appendChild(inner)
  return nav
}

// ================= MAIN CONTENT =================
function mainContent() {
  const wrap = el('main', { class: 'flex-1 max-w-2xl w-full mx-auto px-4 py-4 fade-in' })
  if (view === 'home') loadFeed(wrap)
  else if (view === 'create') wrap.appendChild(createView())
  else if (view === 'discover') loadDiscover(wrap)
  else if (view === 'profile') wrap.appendChild(profileView())
  else if (view === 'settings') wrap.appendChild(settingsView())
  else if (view === 'edit-profile') wrap.appendChild(editProfileView())
  else if (view === 'user-profile') loadUserProfile(wrap)
  return wrap
}

// ================= HOME FEED =================
async function loadFeed(wrap) {
  wrap.innerHTML = loader('Loading feed...')
  try {
    const { feed } = await api('/api/feed')
    wrap.innerHTML = ''
    if (!feed.length) {
      wrap.appendChild(emptyState('fa-rss', 'No posts yet', 'Create flashcards or quizzes to see them here!'))
      return
    }
    feed.forEach(item => wrap.appendChild(feedCard(item)))
  } catch (e) { toast(e.message, 'error') }
}

function feedCard(item) {
  const isFlashcard = item.content_type === 'flashcard'
  const timeAgo = relativeTime(item.created_at)
  const avatarSrc = item.avatar || defaultAvatar()

  const card = el('article', { class: 'rounded-2xl border mb-4 overflow-hidden ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') })

  // Header with user info
  const header = el('div', { class: 'flex items-center gap-3 p-4 pb-2' },
    el('img', { src: avatarSrc, class: 'w-10 h-10 rounded-full object-cover border-2 ' + dc('border-slate-100', 'border-gray-600') }),
    el('div', { class: 'flex-1 min-w-0' },
      el('button', {
        class: 'font-semibold text-sm hover:underline cursor-pointer',
        onclick: () => { viewingUserId = item.user_id; view = 'user-profile'; render() }
      }, item.full_name || item.username),
      el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, timeAgo)
    ),
    el('span', {
      class: `text-xs font-medium px-2.5 py-1 rounded-full ${
        isFlashcard
          ? dc('bg-indigo-50 text-indigo-600', 'bg-indigo-900/40 text-indigo-400')
          : dc('bg-emerald-50 text-emerald-600', 'bg-emerald-900/40 text-emerald-400')
      }`
    }, isFlashcard ? 'Flashcards' : 'Quiz')
  )

  // Content
  const content = el('div', { class: 'px-4 pb-2' },
    el('h3', { class: 'font-semibold text-base mb-1' }, item.title)
  )

  if (isFlashcard) {
    const count = item.cards.length
    content.appendChild(el('p', { class: 'text-sm ' + dc('text-slate-500', 'text-gray-400') }, `${count} flashcards`))

    // Show preview of first 2 cards
    const preview = el('div', { class: 'mt-2 space-y-1' })
    item.cards.slice(0, 2).forEach(c => {
      preview.appendChild(el('div', {
        class: 'text-xs px-3 py-2 rounded-lg ' + dc('bg-slate-50', 'bg-gray-700')
      }, el('span', { class: 'font-medium' }, c.front)))
    })
    if (count > 2) preview.appendChild(el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `+${count - 2} more cards`))
    content.appendChild(preview)
  } else {
    const count = item.questions.length
    const typeStr = item.types.map(t => TYPE_LABELS[t] || t).join(', ')
    content.appendChild(el('div', { class: 'flex flex-wrap items-center gap-2' },
      difficultyBadge(item.difficulty),
      el('p', { class: 'text-sm ' + dc('text-slate-500', 'text-gray-400') }, `${count} questions · ${typeStr}`)
    ))
  }

  // Action bar
  const actions = el('div', { class: 'flex items-center gap-2 px-4 py-3 border-t ' + dc('border-slate-100', 'border-gray-700') })

  if (isFlashcard) {
    const expandBody = el('div', { class: 'hidden px-4 pb-4' })
    expandBody.appendChild(flashcardGrid(item.cards))
    const toggleBtn = el('button', {
      class: 'flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg ' + dc('text-indigo-600 hover:bg-indigo-50', 'text-indigo-400 hover:bg-indigo-900/30'),
      onclick: () => expandBody.classList.toggle('hidden')
    }, el('i', { class: 'fas fa-eye' }), 'View Cards')
    actions.appendChild(toggleBtn)
    // Only the creator of the flashcards can turn them into a quiz
    if (me && item.user_id === me.id) actions.appendChild(makeQuizBtn(item))
    actions.appendChild(shareBtn('/share/flashcards/' + item.share_id))
    card.append(header, content, actions, expandBody)
  } else {
    actions.appendChild(startQuizBtn(item.share_id))
    if (me && item.user_id === me.id) actions.appendChild(statsBtn(item))
    actions.appendChild(shareBtn('/quiz/' + item.share_id))
    card.append(header, content, actions)
  }

  return card
}

// ================= DISCOVER =================
async function loadDiscover(wrap) {
  wrap.innerHTML = ''

  // Search bar
  const searchInput = el('input', {
    type: 'text',
    placeholder: 'Search users...',
    class: 'w-full rounded-xl px-4 py-3 text-sm border ' + dc('bg-white border-slate-200 focus:border-indigo-500', 'bg-gray-800 border-gray-600 focus:border-indigo-400 text-white')
  })

  const searchWrap = el('div', { class: 'relative mb-4' },
    el('i', { class: 'fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-sm ' + dc('text-slate-400', 'text-gray-500') }),
    searchInput
  )
  searchInput.style.paddingLeft = '2.5rem'

  const results = el('div', {})
  wrap.append(searchWrap, results)

  async function doSearch(q) {
    results.innerHTML = loader('Searching...')
    try {
      const { users } = await api('/api/discover/users?q=' + encodeURIComponent(q))
      results.innerHTML = ''
      if (!users.length) {
        results.appendChild(emptyState('fa-users', 'No users found', q ? 'Try a different search term' : 'No other users have signed up yet'))
        return
      }
      users.forEach(u => results.appendChild(discoverCard(u)))
    } catch (e) { toast(e.message, 'error') }
  }

  let debounce = null
  searchInput.oninput = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => doSearch(searchInput.value), 400)
  }

  doSearch('')
}

function discoverCard(u) {
  const avatarSrc = u.avatar || defaultAvatar()
  const card = el('div', {
    class: 'flex items-center gap-3 p-3 rounded-xl mb-2 cursor-pointer transition ' + dc('bg-white hover:bg-slate-50 border border-slate-200', 'bg-gray-800 hover:bg-gray-750 border border-gray-700'),
    onclick: () => { viewingUserId = u.id; view = 'user-profile'; render() }
  },
    el('img', { src: avatarSrc, class: 'w-12 h-12 rounded-full object-cover' }),
    el('div', { class: 'flex-1 min-w-0' },
      el('p', { class: 'font-semibold text-sm truncate' }, u.full_name || u.username),
      el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `@${u.username}`),
      el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `${u.flashcard_count} flashcards · ${u.quiz_count} quizzes`)
    ),
    friendActionBtn(u)
  )
  return card
}

function friendActionBtn(u) {
  if (u.friend_status === 'friends') {
    return el('span', { class: 'text-xs font-medium px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
      el('i', { class: 'fas fa-check mr-1' }), 'Friends')
  }
  if (u.friend_status === 'pending_sent') {
    return el('span', { class: 'text-xs font-medium px-3 py-1.5 rounded-full ' + dc('bg-slate-100 text-slate-500', 'bg-gray-700 text-gray-400') },
      'Pending')
  }
  if (u.friend_status === 'pending_received') {
    const btn = el('button', {
      class: 'text-xs font-medium px-3 py-1.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-700',
      onclick: async (e) => {
        e.stopPropagation()
        await api('/api/friends/accept', { method: 'POST', body: JSON.stringify({ user_id: u.id }) })
        toast('Friend request accepted!', 'success')
        view = 'discover'; render()
      }
    }, 'Accept')
    return btn
  }
  // none
  const btn = el('button', {
    class: 'text-xs font-medium px-3 py-1.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-700',
    onclick: async (e) => {
      e.stopPropagation()
      try {
        await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ user_id: u.id }) })
        toast('Friend request sent!', 'success')
        btn.textContent = 'Pending'
        btn.disabled = true
        btn.className = 'text-xs font-medium px-3 py-1.5 rounded-full ' + dc('bg-slate-100 text-slate-500', 'bg-gray-700 text-gray-400')
      } catch (e) { toast(e.message, 'error') }
    }
  }, el('i', { class: 'fas fa-user-plus mr-1' }), 'Add Friend')
  return btn
}

// ================= USER PROFILE (stalk mode) =================
async function loadUserProfile(wrap) {
  wrap.innerHTML = loader('Loading profile...')
  try {
    const data = await api('/api/users/' + viewingUserId + '/profile')
    wrap.innerHTML = ''

    const u = data.user
    const avatarSrc = u.avatar || defaultAvatar()

    // Profile header
    const header = el('div', { class: 'text-center mb-6' },
      el('img', { src: avatarSrc, class: 'w-24 h-24 rounded-full object-cover mx-auto border-4 ' + dc('border-indigo-100', 'border-indigo-900/50') }),
      el('h2', { class: 'text-xl font-bold mt-3' }, u.full_name || u.username),
      el('p', { class: 'text-sm ' + dc('text-slate-500', 'text-gray-400') }, `@${u.username}`),
      u.bio ? el('p', { class: 'text-sm mt-2 ' + dc('text-slate-600', 'text-gray-300') }, u.bio) : null
    )
    wrap.appendChild(header)

    // Friend action
    const friendRow = el('div', { class: 'flex justify-center gap-2 mb-6' })
    if (data.friend_status === 'friends') {
      friendRow.appendChild(el('button', {
        class: 'text-sm font-medium px-4 py-2 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400',
        onclick: async () => {
          if (!confirm('Remove friend?')) return
          await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ user_id: u.id }) })
          toast('Friend removed', 'success')
          render()
        }
      }, el('i', { class: 'fas fa-user-minus mr-1' }), 'Unfriend'))
    } else if (data.friend_status === 'pending_sent') {
      friendRow.appendChild(el('span', { class: 'text-sm px-4 py-2 rounded-lg ' + dc('bg-slate-100 text-slate-500', 'bg-gray-700 text-gray-400') }, 'Request Pending'))
    } else if (data.friend_status === 'pending_received') {
      friendRow.appendChild(el('button', {
        class: 'text-sm font-medium px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700',
        onclick: async () => {
          await api('/api/friends/accept', { method: 'POST', body: JSON.stringify({ user_id: u.id }) })
          toast('Friend request accepted!', 'success')
          render()
        }
      }, 'Accept Request'))
    } else {
      friendRow.appendChild(el('button', {
        class: 'text-sm font-medium px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700',
        onclick: async () => {
          await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ user_id: u.id }) })
          toast('Friend request sent!', 'success')
          render()
        }
      }, el('i', { class: 'fas fa-user-plus mr-1' }), 'Add Friend'))
    }
    wrap.appendChild(friendRow)

    // Stats
    const stats = el('div', { class: 'grid grid-cols-2 gap-3 mb-6' },
      statCard('fa-layer-group', 'Flashcard Sets', data.flashcards.length),
      statCard('fa-circle-question', 'Quizzes', data.quizzes.length)
    )
    wrap.appendChild(stats)

    // Flashcard sets
    if (data.flashcards.length) {
      wrap.appendChild(el('h3', { class: 'font-semibold mb-3' }, 'Flashcard Sets'))
      data.flashcards.forEach(s => {
        const body = el('div', { class: 'mt-3 hidden' })
        body.appendChild(flashcardGrid(s.cards))
        const card = el('div', { class: 'rounded-xl border p-4 mb-3 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
          el('div', { class: 'flex items-center justify-between' },
            el('div', {},
              el('h4', { class: 'font-semibold text-sm' }, s.title),
              el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `${s.cards.length} cards`)
            ),
            el('div', { class: 'flex gap-2' },
              iconBtn('fa-eye', dc('text-slate-500', 'text-gray-400'), () => body.classList.toggle('hidden')),
              shareBtn('/share/flashcards/' + s.share_id)
            )
          ),
          body
        )
        wrap.appendChild(card)
      })
    }

    // Quizzes
    if (data.quizzes.length) {
      wrap.appendChild(el('h3', { class: 'font-semibold mb-3 mt-4' }, 'Quizzes'))
      data.quizzes.forEach(q => {
        const card = el('div', { class: 'rounded-xl border p-4 mb-3 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
          el('div', { class: 'flex items-center justify-between gap-2' },
            el('div', {},
              el('h4', { class: 'font-semibold text-sm' }, q.title),
              el('div', { class: 'flex items-center gap-2 mt-1' },
                difficultyBadge(q.difficulty),
                el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `${q.questions.length} questions`))
            ),
            el('div', { class: 'flex gap-2' },
              startQuizBtn(q.share_id),
              shareBtn('/quiz/' + q.share_id)
            )
          )
        )
        wrap.appendChild(card)
      })
    }

    if (!data.flashcards.length && !data.quizzes.length) {
      wrap.appendChild(emptyState('fa-ghost', 'Nothing here yet', 'This user hasn\'t created any content'))
    }
  } catch (e) { toast(e.message, 'error') }
}

function statCard(icon, label, value) {
  return el('div', { class: 'text-center p-4 rounded-xl border ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('i', { class: 'fas ' + icon + ' text-xl text-indigo-500 mb-1' }),
    el('p', { class: 'text-2xl font-bold' }, String(value)),
    el('p', { class: 'text-xs ' + dc('text-slate-500', 'text-gray-400') }, label)
  )
}

// ================= FRIEND REQUESTS MODAL =================
async function showFriendRequests() {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4' })
  const panel = el('div', { class: 'w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[80vh] overflow-y-auto ' + dc('bg-white', 'bg-gray-800') })

  const headerEl = el('div', { class: 'sticky top-0 p-4 border-b flex items-center justify-between ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('h2', { class: 'font-bold text-lg' }, 'Friend Requests'),
    el('button', { class: dc('text-slate-400 hover:text-slate-600', 'text-gray-400 hover:text-gray-200'), onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times text-xl' }))
  )
  panel.appendChild(headerEl)

  const body = el('div', { class: 'p-4' })
  body.innerHTML = loader('Loading...')
  panel.appendChild(body)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)

  try {
    const { requests } = await api('/api/friends/requests')
    body.innerHTML = ''
    if (!requests.length) {
      body.appendChild(el('p', { class: 'text-center py-6 text-sm ' + dc('text-slate-400', 'text-gray-500') }, 'No pending friend requests'))
      return
    }
    requests.forEach(r => {
      const row = el('div', { class: 'flex items-center gap-3 py-3 border-b last:border-0 ' + dc('border-slate-100', 'border-gray-700') },
        el('img', { src: r.avatar || defaultAvatar(), class: 'w-11 h-11 rounded-full object-cover' }),
        el('div', { class: 'flex-1 min-w-0' },
          el('p', { class: 'font-semibold text-sm' }, r.full_name || r.username),
          el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, '@' + r.username)
        ),
        el('div', { class: 'flex gap-2' },
          el('button', {
            class: 'text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700',
            onclick: async () => {
              await api('/api/friends/accept', { method: 'POST', body: JSON.stringify({ user_id: r.id }) })
              toast('Accepted!', 'success')
              overlay.remove()
              render()
            }
          }, 'Accept'),
          el('button', {
            class: 'text-xs font-medium px-3 py-1.5 rounded-lg ' + dc('bg-slate-100 text-slate-600 hover:bg-slate-200', 'bg-gray-700 text-gray-300 hover:bg-gray-600'),
            onclick: async () => {
              await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ user_id: r.id }) })
              toast('Declined', 'info')
              overlay.remove()
              render()
            }
          }, 'Decline')
        )
      )
      body.appendChild(row)
    })
  } catch (e) { toast(e.message, 'error') }
}

// ================= CREATE =================
// The Create page has two tools: AI Flashcards and the Quiz Maker.
let createTab = 'flashcards' // flashcards | quiz
function createView() {
  const wrap = el('div', {})
  const tabCls = (t) => 'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition ' + (createTab === t
    ? 'bg-indigo-600 text-white shadow'
    : dc('text-slate-600 hover:bg-slate-100', 'text-gray-300 hover:bg-gray-700'))
  const tabs = el('div', { id: 'create-tabs', class: 'flex gap-2 p-1.5 rounded-2xl border mb-5 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('button', { class: tabCls('flashcards'), onclick: () => { createTab = 'flashcards'; render() } }, el('i', { class: 'fas fa-layer-group' }), 'Flashcards'),
    el('button', { class: tabCls('quiz'), onclick: () => { createTab = 'quiz'; render() } }, el('i', { class: 'fas fa-circle-question' }), 'Quiz Maker')
  )
  wrap.appendChild(tabs)
  wrap.appendChild(createTab === 'quiz' ? quizMakerView() : flashcardCreateView())
  return wrap
}

function flashcardCreateView() {
  const container = el('div', {})

  const textarea = el('textarea', {
    class: 'w-full h-56 border rounded-xl p-4 text-sm resize-y ' + dc('bg-white border-slate-300 focus:border-indigo-500', 'bg-gray-800 border-gray-600 focus:border-indigo-400 text-white placeholder-gray-500'),
    placeholder: 'Upload a PDF or paste your notes here.'
  })
  textarea.value = sourceText
  textarea.oninput = () => { sourceText = textarea.value }

  const fileInput = el('input', { type: 'file', accept: '.pdf,.txt', class: 'hidden' })
  const uploadBtn = el('button', {
    class: 'flex items-center gap-2 border px-4 py-2 rounded-lg text-sm font-medium ' + dc('border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100', 'border-indigo-700 bg-indigo-900/30 text-indigo-400 hover:bg-indigo-900/50'),
    onclick: () => fileInput.click()
  }, el('i', { class: 'fas fa-file-arrow-up' }), 'Upload PDF / notes')

  fileInput.onchange = async () => {
    const file = fileInput.files[0]
    if (!file) return
    uploadBtn.innerHTML = '<span class="spinner spinner-dark"></span> Extracting text...'
    try {
      let text = ''
      if (file.name.toLowerCase().endsWith('.pdf')) text = await pdfToText(file)
      else text = await file.text()
      sourceText = text
      textarea.value = text
      toast('Text extracted — edit it if needed', 'success')
    } catch (e) {
      toast('Could not read file: ' + e.message, 'error')
    }
    uploadBtn.innerHTML = '<i class="fas fa-file-arrow-up"></i> Upload PDF / notes'
  }

  const countLabel = el('span', { class: 'font-bold text-indigo-600 dark:text-indigo-400' }, '30')
  const slider = el('input', {
    type: 'range', min: '10', max: '50', value: '30', step: '5',
    class: 'w-full accent-indigo-600'
  })
  slider.oninput = () => { countLabel.textContent = slider.value }

  const titleInput = el('input', {
    class: 'w-full border rounded-lg px-3 py-2 text-sm ' + dc('border-slate-300 bg-white', 'border-gray-600 bg-gray-800 text-white'),
    placeholder: 'Title (optional)'
  })

  const genBtn = el('button', {
    class: 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2'
  }, el('i', { class: 'fas fa-wand-magic-sparkles' }), 'Generate flashcards with AI')

  const output = el('div', { class: 'mt-6' })

  genBtn.onclick = async () => {
    if (!sourceText || sourceText.trim().length < 20)
      return toast('Add more study text first', 'error')
    genBtn.disabled = true
    genBtn.innerHTML = '<span class="spinner"></span> Creating flashcards...'
    try {
      const data = await api('/api/flashcards/generate', {
        method: 'POST',
        body: JSON.stringify({ text: sourceText, count: Number(slider.value), title: titleInput.value })
      })
      currentSet = data
      output.querySelectorAll('.ai-error-notice').forEach((n) => n.remove())
      toast(`${data.cards.length} flashcards created & saved` + (data.strategy === 'dual-batch' ? ' (in 2 batches)' : ''), 'success')
      renderGenerated(output, data)
    } catch (e) {
      toast(e.message, 'error')
      showAiError(output, e, () => genBtn.click())
    }
    genBtn.disabled = false
    genBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate flashcards with AI'
  }

  container.append(
    stepCard('1', 'Add your lesson', el('div', {}, textarea, el('div', { class: 'mt-3' }, uploadBtn, fileInput))),
    stepCard('2', 'Choose how many flashcards', el('div', {},
      el('div', { class: 'flex items-center justify-between mb-1 text-sm' },
        el('span', { class: dc('text-slate-500', 'text-gray-400') }, '10'),
        el('span', {}, 'Cards: ', countLabel),
        el('span', { class: dc('text-slate-500', 'text-gray-400') }, '50')
      ),
      slider,
      el('div', { class: 'mt-3' }, titleInput)
    )),
    stepCard('3', 'Generate', el('div', {}, genBtn, output))
  )
  return container
}

function stepCard(n, title, body) {
  return el('section', { class: 'rounded-2xl border p-5 mb-5 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('div', { class: 'flex items-center gap-2 mb-3' },
      el('span', { class: 'w-7 h-7 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center' }, n),
      el('h2', { class: 'font-semibold' }, title)
    ),
    body
  )
}

function renderGenerated(output, data) {
  output.innerHTML = ''
  output.appendChild(el('div', { class: 'flex items-center justify-between mt-5 mb-3' },
    el('h3', { class: 'font-semibold' }, `Preview (${data.cards.length} cards)`),
    shareBtn('/share/flashcards/' + data.share_id)
  ))
  output.appendChild(flashcardGrid(data.cards))
  output.appendChild(quizBuilder(data))
}

// Open the "make a quiz" builder for any saved flashcard set (creator only)
function openQuizBuilderModal(set) {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4' })
  const panel = el('div', { class: 'w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto ' + dc('bg-white', 'bg-gray-800') })
  panel.appendChild(el('div', { class: 'sticky top-0 p-4 border-b flex items-center justify-between z-10 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('div', { class: 'min-w-0' },
      el('h2', { class: 'font-bold text-lg' }, 'Create a quiz'),
      el('p', { class: 'text-xs truncate ' + dc('text-slate-500', 'text-gray-400') }, `From: ${set.title} (${set.cards.length} cards)`)),
    el('button', { class: dc('text-slate-500 hover:text-slate-700', 'text-gray-400 hover:text-gray-200'), onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times text-xl' }))
  ))
  const body = el('div', { class: 'p-4' })
  body.appendChild(quizBuilder(set, true))
  panel.appendChild(body)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
}

function makeQuizBtn(set) {
  return el('button', {
    class: 'flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg ' + dc('text-emerald-700 hover:bg-emerald-50', 'text-emerald-400 hover:bg-emerald-900/30'),
    onclick: (e) => { e.stopPropagation(); openQuizBuilderModal(set) }
  }, el('i', { class: 'fas fa-circle-question' }), 'Make Quiz')
}

function startQuizBtn(shareId) {
  return el('button', {
    class: 'flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700',
    onclick: (e) => { e.stopPropagation(); location.href = '/quiz/' + shareId }
  }, el('i', { class: 'fas fa-play' }), 'Start Quiz')
}

function statsBtn(quiz) {
  return el('button', {
    class: 'flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg ' + dc('text-indigo-700 hover:bg-indigo-50', 'text-indigo-400 hover:bg-indigo-900/30'),
    onclick: (e) => { e.stopPropagation(); showQuizStats(quiz) }
  }, el('i', { class: 'fas fa-chart-simple' }), 'Stats')
}

const DIFFICULTY = {
  easy: { label: 'Easy', light: 'bg-emerald-100 text-emerald-800', dark: 'bg-emerald-900/40 text-emerald-300', icon: 'fa-seedling' },
  medium: { label: 'Medium', light: 'bg-amber-100 text-amber-800', dark: 'bg-amber-900/40 text-amber-300', icon: 'fa-gauge' },
  hard: { label: 'Hard', light: 'bg-red-100 text-red-800', dark: 'bg-red-900/40 text-red-300', icon: 'fa-fire' }
}
function difficultyBadge(level) {
  const d = DIFFICULTY[level] || DIFFICULTY.medium
  return el('span', { class: 'inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ' + dc(d.light, d.dark) },
    el('i', { class: 'fas ' + d.icon }), d.label)
}

// ================= QUIZ STATS (creator only) =================
async function showQuizStats(quiz) {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4' })
  const panel = el('div', { class: 'w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[85vh] overflow-y-auto ' + dc('bg-white', 'bg-gray-800') })
  panel.appendChild(el('div', { class: 'sticky top-0 p-4 border-b flex items-center justify-between z-10 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('div', { class: 'min-w-0' },
      el('h2', { class: 'font-bold text-lg' }, 'Quiz Stats'),
      el('p', { class: 'text-xs truncate ' + dc('text-slate-500', 'text-gray-400') }, quiz.title)),
    el('button', { class: dc('text-slate-500 hover:text-slate-700', 'text-gray-400 hover:text-gray-200'), onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times text-xl' }))
  ))
  const body = el('div', { class: 'p-4' })
  body.innerHTML = loader('Loading stats...')
  panel.appendChild(body)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)

  try {
    const { attempts, quiz: q } = await api('/api/quiz/' + quiz.id + '/stats')
    body.innerHTML = ''
    const players = new Set(attempts.map(a => a.user_id)).size
    const avg = attempts.length ? Math.round(attempts.reduce((t, a) => t + (a.total ? a.correct / a.total : 0), 0) / attempts.length * 100) : 0
    body.appendChild(el('div', { class: 'grid grid-cols-3 gap-2 mb-4' },
      miniStat('Attempts', attempts.length), miniStat('Players', players), miniStat('Avg score', avg + '%')))
    body.appendChild(el('p', { class: 'text-xs mb-3 ' + dc('text-slate-500', 'text-gray-400') },
      el('i', { class: 'fas fa-lock mr-1' }), 'Only you (the creator) can see these stats.'))
    if (!attempts.length) {
      body.appendChild(el('p', { class: 'text-center py-6 text-sm ' + dc('text-slate-500', 'text-gray-400') }, 'Nobody has answered this quiz yet.'))
      return
    }
    const statusMap = {
      completed: ['Completed', dc('bg-indigo-100 text-indigo-800', 'bg-indigo-900/40 text-indigo-300')],
      mastered: ['Mastered', dc('bg-emerald-100 text-emerald-800', 'bg-emerald-900/40 text-emerald-300')],
      gave_up: ['Gave up', dc('bg-red-100 text-red-800', 'bg-red-900/40 text-red-300')]
    }
    attempts.forEach(a => {
      const pct = a.total ? Math.round(a.correct / a.total * 100) : 0
      const st = statusMap[a.status] || statusMap.completed
      body.appendChild(el('div', { class: 'flex items-center gap-3 py-3 border-b last:border-0 ' + dc('border-slate-100', 'border-gray-700') },
        el('img', { src: a.avatar || defaultAvatar(), class: 'w-10 h-10 rounded-full object-cover' }),
        el('div', { class: 'flex-1 min-w-0' },
          el('p', { class: 'font-semibold text-sm truncate' }, a.full_name || a.username),
          el('p', { class: 'text-xs ' + dc('text-slate-500', 'text-gray-400') },
            `@${a.username} · ${new Date(a.created_at + 'Z').toLocaleString()}`),
          el('p', { class: 'text-xs mt-0.5 ' + dc('text-slate-600', 'text-gray-300') },
            `✓ ${a.correct}  ✕ ${a.wrong}  · answered ${a.answered}/${a.total} · ${a.rounds} ${a.rounds === 1 ? 'round' : 'rounds'}`)
        ),
        el('div', { class: 'text-right flex flex-col items-end' },
          el('p', { class: 'font-bold' }, `${a.correct}/${a.total}`),
          el('p', { class: 'text-xs ' + dc('text-slate-500', 'text-gray-400') }, pct + '%'),
          el('span', { class: 'inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ' + st[1] }, st[0]),
          el('button', {
            class: 'view-answers-btn mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700',
            onclick: () => showAttemptAnswers(quiz, a)
          }, el('i', { class: 'fas fa-list-check' }), 'View answers')
        )
      ))
    })
  } catch (e) {
    body.innerHTML = ''
    body.appendChild(el('p', { class: 'text-center py-6 text-sm text-red-500' }, e.message))
  }
}

// Creator only: every question + the player's answer (correct / wrong)
async function showAttemptAnswers(quiz, a) {
  const overlay = el('div', { class: 'fixed inset-0 z-[60] bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4' })
  const panel = el('div', { class: 'w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto ' + dc('bg-white', 'bg-gray-800') })
  const who = a.full_name || a.username
  panel.appendChild(el('div', { class: 'sticky top-0 p-4 border-b flex items-center gap-3 z-10 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('img', { src: a.avatar || defaultAvatar(), class: 'w-10 h-10 rounded-full object-cover' }),
    el('div', { class: 'flex-1 min-w-0' },
      el('h2', { class: 'font-bold truncate' }, who + "'s answers"),
      el('p', { class: 'text-xs truncate ' + dc('text-slate-500', 'text-gray-400') }, `${quiz.title} · ✓ ${a.correct}  ✕ ${a.wrong} · ${a.correct}/${a.total}`)),
    el('button', { class: dc('text-slate-500 hover:text-slate-700', 'text-gray-400 hover:text-gray-200'), onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times text-xl' }))
  ))
  const body = el('div', { class: 'p-4 space-y-3' })
  body.innerHTML = loader('Loading answers...')
  panel.appendChild(body)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)

  try {
    const data = await api(`/api/quiz/${quiz.id}/attempts/${a.id}`)
    body.innerHTML = ''
    if (!data.attempt.has_details) {
      body.appendChild(el('p', { class: 'text-sm text-center py-2 px-3 rounded-lg ' + dc('bg-amber-50 text-amber-800', 'bg-amber-900/30 text-amber-300') },
        el('i', { class: 'fas fa-circle-info mr-1' }), 'This attempt was saved before answer tracking was added, so the individual answers are not available.'))
    }
    const norm = (x) => String(x || '').trim().toLowerCase()
    const LET = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    data.questions.forEach((q) => {
      const status = !q.answered
        ? el('span', { class: 'text-[11px] font-semibold px-2 py-0.5 rounded-full ' + dc('bg-slate-100 text-slate-700', 'bg-gray-700 text-gray-300') }, 'Not answered')
        : q.correct
          ? el('span', { class: 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800' }, el('i', { class: 'fas fa-check mr-1' }), 'Correct')
          : el('span', { class: 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-800' }, el('i', { class: 'fas fa-xmark mr-1' }), 'Wrong')
      const card = el('article', { class: 'answer-review-card rounded-xl border p-3 ' + (q.answered ? (q.correct ? 'border-emerald-300' : 'border-red-300') : dc('border-slate-200', 'border-gray-700')) },
        el('div', { class: 'flex items-center justify-between gap-2 mb-1' },
          el('span', { class: 'text-xs font-semibold ' + dc('text-slate-500', 'text-gray-400') }, `Question ${q.index + 1} · ${TYPE_LABELS[q.type] || q.type}`),
          status),
        el('p', { class: 'font-medium text-sm mb-2' }, q.question))
      if (q.options && q.options.length) {
        const ul = el('ul', { class: 'space-y-1' })
        q.options.forEach((o, oi) => {
          const isAns = norm(o) === norm(q.answer)
          const isChosen = q.answered && norm(o) === norm(q.chosen)
          let cls = dc('bg-slate-50 text-slate-700', 'bg-gray-900 text-gray-300')
          if (isAns) cls = 'bg-emerald-100 text-emerald-900 font-semibold'
          if (isChosen && !isAns) cls = 'bg-red-100 text-red-900 font-semibold'
          ul.appendChild(el('li', { class: 'text-sm px-3 py-1.5 rounded-lg flex items-center gap-2 ' + cls },
            el('span', {}, (LET[oi] || '•') + '.'), el('span', { class: 'flex-1' }, o),
            isChosen ? el('span', { class: 'text-[10px] font-bold uppercase' }, 'Their answer') : null,
            isAns ? el('i', { class: 'fas fa-check' }) : null))
        })
        card.appendChild(ul)
      } else {
        card.appendChild(el('p', { class: 'text-sm' }, 'Their answer: ',
          el('span', { class: 'font-semibold ' + (q.answered ? (q.correct ? 'text-emerald-600' : 'text-red-600') : '') }, q.answered ? q.chosen : '—')))
        card.appendChild(el('p', { class: 'text-sm' }, 'Correct answer: ', el('span', { class: 'font-semibold text-emerald-600' }, q.answer)))
      }
      if (q.explanation) card.appendChild(el('p', { class: 'text-xs mt-2 ' + dc('text-slate-600', 'text-gray-400') }, q.explanation))
      body.appendChild(card)
    })
  } catch (e) {
    body.innerHTML = ''
    body.appendChild(el('p', { class: 'text-center py-6 text-sm text-red-500' }, e.message))
  }
}

function miniStat(label, value) {
  return el('div', { class: 'text-center p-3 rounded-xl border ' + dc('bg-gray-50 border-slate-200', 'bg-gray-900 border-gray-700') },
    el('p', { class: 'text-lg font-bold' }, String(value)),
    el('p', { class: 'text-[11px] ' + dc('text-slate-500', 'text-gray-400') }, label))
}

function flashcardGrid(cards) {
  const grid = el('div', { class: 'grid sm:grid-cols-2 gap-3' })
  cards.forEach((c, i) => {
    const inner = el('div', { class: 'card-inner w-full h-40' },
      el('div', { class: 'card-face card-front font-medium ' + dc('bg-indigo-50 border border-indigo-100 text-slate-800', 'bg-indigo-900/30 border border-indigo-800 text-indigo-100') }, c.front),
      el('div', { class: 'card-face card-back bg-indigo-600 text-white' }, c.back)
    )
    const card = el('div', { class: 'card-flip cursor-pointer', onclick: () => inner.classList.toggle('flipped') },
      inner,
      el('div', { class: 'text-xs mt-1 text-center ' + dc('text-slate-400', 'text-gray-500') }, `Card ${i + 1} · tap to flip`)
    )
    grid.appendChild(card)
  })
  return grid
}

// ================= QUIZ BUILDER =================
function quizBuilder(flashData, inModal = false) {
  const types = ['multiple_choice', 'situational', 'true_false', 'identification']
  const selected = new Set(['multiple_choice'])

  const chips = el('div', { class: 'flex flex-wrap gap-2 mb-4' })
  types.forEach((t) => {
    const chip = el('button', {
      class: chipCls(selected.has(t)),
      onclick: () => {
        if (selected.has(t)) selected.delete(t)
        else selected.add(t)
        chip.className = chipCls(selected.has(t))
      }
    }, TYPE_LABELS[t])
    chips.appendChild(chip)
  })

  const qCountLabel = el('span', { class: 'font-bold text-emerald-600 dark:text-emerald-400' }, '10')
  const qSlider = el('input', {
    type: 'range', min: '10', max: '50', value: '10', step: '5',
    class: 'w-full accent-emerald-600'
  })
  qSlider.oninput = () => { qCountLabel.textContent = qSlider.value }

  // Difficulty level
  let difficulty = 'medium'
  const diffWrap = el('div', { class: 'grid grid-cols-3 gap-2 mb-4' })
  const diffCls = (lvl) => {
    const active = lvl === difficulty
    const d = DIFFICULTY[lvl]
    return 'flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium border ' + (active
      ? 'border-transparent ring-2 ring-offset-1 ring-indigo-500 ' + dc(d.light, d.dark)
      : dc('bg-white text-slate-700 border-slate-300', 'bg-gray-800 text-gray-300 border-gray-600'))
  }
  ;['easy', 'medium', 'hard'].forEach((lvl) => {
    const b = el('button', { class: diffCls(lvl), onclick: () => {
      difficulty = lvl
      ;[...diffWrap.children].forEach((c) => { c.className = diffCls(c.dataset.lvl) })
    } }, el('i', { class: 'fas ' + DIFFICULTY[lvl].icon }), DIFFICULTY[lvl].label)
    b.dataset.lvl = lvl
    diffWrap.appendChild(b)
  })

  const btn = el('button', {
    class: 'w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2'
  }, el('i', { class: 'fas fa-circle-question' }), 'Turn cards into a quiz')

  const out = el('div', { class: 'mt-4' })

  btn.onclick = async () => {
    if (selected.size === 0) return toast('Pick at least one quiz type', 'error')
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span> Building quiz...'
    try {
      const data = await api('/api/quiz/generate', {
        method: 'POST',
        body: JSON.stringify({
          flashcard_set_id: flashData.id,
          types: [...selected],
          count: Number(qSlider.value),
          difficulty,
          title: flashData.title + ' — Quiz'
        })
      })
      toast('Quiz created & saved', 'success')
      out.innerHTML = ''
      out.appendChild(el('div', { class: 'rounded-xl border p-4 ' + dc('bg-emerald-50 border-emerald-200', 'bg-emerald-900/20 border-emerald-800') },
        el('div', { class: 'flex items-center gap-2 mb-1' },
          el('i', { class: 'fas fa-circle-check text-emerald-600' }),
          el('h3', { class: 'font-semibold' }, data.title)),
        el('div', { class: 'flex items-center gap-2 mb-3' },
          difficultyBadge(data.difficulty),
          el('span', { class: 'text-sm ' + dc('text-slate-600', 'text-gray-300') }, `${data.questions.length} questions`)),
        el('div', { class: 'flex flex-wrap gap-2' },
          startQuizBtn(data.share_id),
          shareBtn('/quiz/' + data.share_id))
      ))
    } catch (e) {
      toast(e.message, 'error')
      showAiError(out, e, () => btn.click())
    }
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-circle-question"></i> Turn cards into a quiz'
  }

  return el('section', { class: inModal ? '' : 'mt-8 border-t pt-6 ' + dc('border-slate-200', 'border-gray-700') },
    inModal ? null : el('h3', { class: 'font-semibold mb-1' }, 'Make a quiz from these cards'),
    el('p', { class: 'text-sm mb-3 ' + dc('text-slate-500', 'text-gray-400') }, 'Select the question types you want:'),
    chips,
    el('p', { class: 'text-sm mb-2 font-medium' }, 'Difficulty level'),
    diffWrap,
    el('div', { class: 'mb-4' },
      el('div', { class: 'flex items-center justify-between mb-1 text-sm' },
        el('span', { class: dc('text-slate-500', 'text-gray-400') }, '10'),
        el('span', {}, 'Questions: ', qCountLabel),
        el('span', { class: dc('text-slate-500', 'text-gray-400') }, '50')
      ),
      qSlider
    ),
    btn, out
  )
}

function chipCls(active) {
  return `px-3 py-1.5 rounded-full text-sm border ${
    active ? 'bg-indigo-600 text-white border-indigo-600' : dc('bg-white text-slate-600 border-slate-300', 'bg-gray-800 text-gray-300 border-gray-600')
  }`
}

const norm = (s) => String(s || '').trim().toLowerCase()

// ================= QUIZ MAKER =================
// Two ways to make a quiz:
//  1) Manually — add questions one by one; each question picks its own type
//     (Multiple Choice / Situational / True or False / Identification).
//  2) With AI — paste questions (+ choices) or upload a PDF. If no answers are
//     provided, the AI figures out the correct answers and builds the quiz.
const QM_TYPES = [
  { id: 'multiple_choice', icon: 'fa-list-ul', hint: 'Pick one of several choices' },
  { id: 'situational', icon: 'fa-people-arrows', hint: 'Scenario with choices' },
  { id: 'true_false', icon: 'fa-circle-half-stroke', hint: 'True or False statement' },
  { id: 'identification', icon: 'fa-keyboard', hint: 'Type the exact answer' }
]
const qm = {
  mode: null, // null | 'manual' | 'ai'
  manual: { title: '', difficulty: 'medium', questions: [] },
  ai: { title: '', text: '', difficulty: 'medium' }
}
function newQuestion(type) {
  return { type, question: '', options: ['', '', '', ''], answer: '', explanation: '' }
}

function quizMakerView() {
  const box = el('div', { id: 'quiz-maker' })
  const draw = () => {
    box.innerHTML = ''
    if (!qm.mode) box.appendChild(qmChooser(draw))
    else if (qm.mode === 'manual') box.appendChild(qmManual(draw))
    else box.appendChild(qmAi(draw))
  }
  draw()
  return box
}

function qmChooser(draw) {
  const option = (mode, icon, color, title, desc) => el('button', {
    class: 'w-full text-left rounded-2xl border p-5 mb-4 flex items-start gap-4 transition hover:shadow-md ' + dc('bg-white border-slate-200 hover:border-indigo-400', 'bg-gray-800 border-gray-700 hover:border-indigo-500'),
    onclick: () => { qm.mode = mode; draw() }
  },
    el('span', { class: `w-12 h-12 shrink-0 rounded-xl flex items-center justify-center text-white text-xl ${color}` }, el('i', { class: 'fas ' + icon })),
    el('span', { class: 'flex-1' },
      el('span', { class: 'block font-bold text-base' }, title),
      el('span', { class: 'block text-sm mt-1 ' + dc('text-slate-500', 'text-gray-400') }, desc)),
    el('i', { class: 'fas fa-chevron-right mt-4 ' + dc('text-slate-400', 'text-gray-500') })
  )
  return el('section', {},
    el('h2', { class: 'font-bold text-lg mb-1' }, 'Make a quiz'),
    el('p', { class: 'text-sm mb-4 ' + dc('text-slate-500', 'text-gray-400') }, 'How do you want to create your quiz?'),
    option('manual', 'fa-pen-to-square', 'bg-indigo-600', 'Create manually',
      'Type each question yourself and choose its type — Multiple Choice, Situational, True or False, or Identification.'),
    option('ai', 'fa-wand-magic-sparkles', 'bg-emerald-600', 'Create with AI',
      'Paste your questions & choices or upload a PDF. If there are no answers, the AI will answer them and make the quiz.')
  )
}

function qmHeader(title, draw) {
  return el('div', { class: 'flex items-center gap-2 mb-4' },
    el('button', {
      class: 'w-9 h-9 rounded-full flex items-center justify-center ' + dc('hover:bg-slate-200 text-slate-600', 'hover:bg-gray-700 text-gray-300'),
      title: 'Back', onclick: () => { qm.mode = null; draw() }
    }, el('i', { class: 'fas fa-arrow-left' })),
    el('h2', { class: 'font-bold text-lg' }, title))
}

function qmDifficultyPicker(state) {
  const wrap = el('div', { class: 'grid grid-cols-3 gap-2' })
  const cls = (lvl) => {
    const d = DIFFICULTY[lvl]
    return 'flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium border ' + (lvl === state.difficulty
      ? 'border-transparent ring-2 ring-offset-1 ring-indigo-500 ' + dc(d.light, d.dark)
      : dc('bg-white text-slate-700 border-slate-300', 'bg-gray-800 text-gray-300 border-gray-600'))
  }
  ;['easy', 'medium', 'hard'].forEach((lvl) => {
    const b = el('button', { type: 'button', class: cls(lvl), onclick: () => {
      state.difficulty = lvl
      ;[...wrap.children].forEach((c) => { c.className = cls(c.dataset.lvl) })
    } }, el('i', { class: 'fas ' + DIFFICULTY[lvl].icon }), DIFFICULTY[lvl].label)
    b.dataset.lvl = lvl
    wrap.appendChild(b)
  })
  return wrap
}

function qmTypePicker(onPick, current) {
  const grid = el('div', { class: 'grid grid-cols-2 gap-2' })
  QM_TYPES.forEach((t) => {
    const active = t.id === current
    grid.appendChild(el('button', {
      type: 'button',
      class: 'flex items-center gap-2 p-2.5 rounded-xl border text-left text-sm ' + (active
        ? 'bg-indigo-600 border-indigo-600 text-white'
        : dc('bg-white border-slate-300 text-slate-700 hover:border-indigo-400', 'bg-gray-900 border-gray-600 text-gray-200 hover:border-indigo-500')),
      onclick: () => onPick(t.id)
    },
      el('i', { class: 'fas ' + t.icon + ' w-4 text-center' }),
      el('span', { class: 'min-w-0' },
        el('span', { class: 'block font-semibold leading-tight' }, TYPE_LABELS[t.id]),
        el('span', { class: 'block text-[11px] leading-tight ' + (active ? 'text-indigo-100' : dc('text-slate-400', 'text-gray-500')) }, t.hint))
    ))
  })
  return grid
}

// ---------- MANUAL ----------
function qmManual(draw) {
  const st = qm.manual
  const container = el('div', {})
  container.appendChild(qmHeader('Create quiz manually', draw))

  const titleInput = el('input', { id: 'qm-title', class: inputCls(), placeholder: 'Quiz title (required)', maxlength: '120' })
  titleInput.value = st.title
  titleInput.oninput = () => { st.title = titleInput.value }

  container.appendChild(stepCard('1', 'Quiz details', el('div', {},
    field('Title', titleInput),
    el('p', { class: 'text-sm font-medium mb-1 ' + dc('text-slate-600', 'text-gray-300') }, 'Difficulty level'),
    qmDifficultyPicker(st)
  )))

  const list = el('div', { id: 'qm-question-list' })
  const drawList = () => {
    list.innerHTML = ''
    if (!st.questions.length) {
      list.appendChild(el('p', { class: 'text-sm text-center py-6 rounded-xl border border-dashed mb-4 ' + dc('text-slate-400 border-slate-300', 'text-gray-500 border-gray-600') },
        'No questions yet. Pick a question type below to add your first question.'))
    }
    st.questions.forEach((q, i) => list.appendChild(qmQuestionEditor(q, i, drawList)))
    countBadge.textContent = st.questions.length
  }
  const countBadge = el('span', { class: 'ml-1 text-xs px-2 py-0.5 rounded-full bg-indigo-600 text-white' }, '0')

  // "Add question" — user chooses the type of every question they add
  const addPanel = el('div', { class: 'rounded-xl border p-3 ' + dc('bg-indigo-50/60 border-indigo-200', 'bg-indigo-900/20 border-indigo-800') },
    el('p', { class: 'text-sm font-semibold mb-2' }, el('i', { class: 'fas fa-plus-circle mr-1 text-indigo-600' }), 'Add a question — choose its type:'),
    qmTypePicker((type) => {
      st.questions.push(newQuestion(type))
      drawList()
      setTimeout(() => {
        const items = list.querySelectorAll('.qm-question textarea')
        const last = items[items.length - 1]
        if (last) { last.focus(); last.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
      }, 50)
    })
  )

  container.appendChild(stepCard('2', 'Questions', el('div', {},
    el('div', { class: 'flex items-center mb-3 text-sm ' + dc('text-slate-500', 'text-gray-400') }, 'Total questions', countBadge),
    list, addPanel)))

  const saveBtn = el('button', {
    id: 'qm-save-btn',
    class: 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2'
  }, el('i', { class: 'fas fa-floppy-disk' }), 'Save quiz')
  const out = el('div', { class: 'mt-4' })
  saveBtn.onclick = async () => {
    if (!st.title.trim()) { titleInput.focus(); return toast('Give your quiz a title', 'error') }
    if (!st.questions.length) return toast('Add at least one question', 'error')
    saveBtn.disabled = true
    saveBtn.innerHTML = '<span class="spinner"></span> Saving quiz...'
    try {
      const payload = st.questions.map((q) => ({
        type: q.type,
        question: q.question,
        options: (q.type === 'multiple_choice' || q.type === 'situational') ? q.options.filter((o) => o.trim()) : undefined,
        answer: q.answer,
        explanation: q.explanation
      }))
      const data = await api('/api/quiz/manual', {
        method: 'POST',
        body: JSON.stringify({ title: st.title, difficulty: st.difficulty, questions: payload })
      })
      toast('Quiz created & saved', 'success')
      // reset the form (keep the result card visible)
      st.title = ''
      st.questions = []
      titleInput.value = ''
      drawList()
      out.innerHTML = ''
      out.appendChild(qmResultCard(data, draw))
      out.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch (e) { toast(e.message, 'error') }
    saveBtn.disabled = false
    saveBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save quiz'
  }
  container.appendChild(stepCard('3', 'Save', el('div', {}, saveBtn, out)))
  drawList()
  return container
}

function qmQuestionEditor(q, i, redraw) {
  const st = qm.manual
  const card = el('div', { class: 'qm-question rounded-xl border p-4 mb-4 ' + dc('bg-gray-50 border-slate-200', 'bg-gray-900 border-gray-700') })
  const smallBtn = (icon, title, fn, extra = '') => el('button', {
    type: 'button', title,
    class: 'w-8 h-8 rounded-lg flex items-center justify-center ' + extra + ' ' + dc('hover:bg-slate-200', 'hover:bg-gray-700'),
    onclick: fn
  }, el('i', { class: 'fas ' + icon + ' text-sm' }))

  // Header: number + type selector + actions
  const typeSelect = el('select', { class: 'border rounded-lg px-2 py-1.5 text-sm ' + dc('bg-white border-slate-300', 'bg-gray-800 border-gray-600 text-white') })
  QM_TYPES.forEach((t) => {
    const o = el('option', { value: t.id }, TYPE_LABELS[t.id])
    if (t.id === q.type) o.selected = true
    typeSelect.appendChild(o)
  })
  typeSelect.onchange = () => {
    q.type = typeSelect.value
    q.answer = ''
    if (!q.options || q.options.length < 2) q.options = ['', '', '', '']
    redraw()
  }
  card.appendChild(el('div', { class: 'flex items-center gap-2 mb-3 flex-wrap' },
    el('span', { class: 'font-bold text-sm' }, `Question ${i + 1}`),
    typeSelect,
    el('span', { class: 'flex-1' }),
    i > 0 ? smallBtn('fa-arrow-up', 'Move up', () => { [st.questions[i - 1], st.questions[i]] = [st.questions[i], st.questions[i - 1]]; redraw() }) : null,
    i < st.questions.length - 1 ? smallBtn('fa-arrow-down', 'Move down', () => { [st.questions[i + 1], st.questions[i]] = [st.questions[i], st.questions[i + 1]]; redraw() }) : null,
    smallBtn('fa-copy', 'Duplicate', () => { st.questions.splice(i + 1, 0, JSON.parse(JSON.stringify(q))); redraw() }),
    smallBtn('fa-trash', 'Delete', () => { if (!q.question.trim() || confirm('Delete this question?')) { st.questions.splice(i, 1); redraw() } }, 'text-red-500')
  ))

  const qText = el('textarea', {
    class: inputCls() + ' h-20 resize-y',
    placeholder: q.type === 'true_false' ? 'Type the statement (e.g. "The sun is a star.")'
      : q.type === 'situational' ? 'Describe the situation and ask the question...'
      : q.type === 'identification' ? 'Type the question (e.g. "What is the powerhouse of the cell?")'
      : 'Type the question...'
  })
  qText.value = q.question
  qText.oninput = () => { q.question = qText.value }
  card.appendChild(qText)

  const answerArea = el('div', { class: 'mt-3' })
  if (q.type === 'multiple_choice' || q.type === 'situational') {
    answerArea.appendChild(el('p', { class: 'text-xs font-medium mb-2 ' + dc('text-slate-500', 'text-gray-400') }, 'Choices — tap the circle to mark the correct answer'))
    const name = 'qm-correct-' + i + '-' + Math.random().toString(36).slice(2, 7)
    const drawChoices = () => {
      choiceList.innerHTML = ''
      q.options.forEach((opt, oi) => {
        const radio = el('input', { type: 'radio', name, class: 'w-5 h-5 accent-emerald-600 shrink-0', title: 'Mark as correct' })
        radio.checked = !!opt.trim() && opt.trim() === q.answer.trim()
        const input = el('input', { class: inputCls() + ' py-2', placeholder: 'Choice ' + String.fromCharCode(65 + oi) })
        input.value = opt
        input.oninput = () => {
          const wasAnswer = radio.checked
          q.options[oi] = input.value
          if (wasAnswer) q.answer = input.value
        }
        radio.onchange = () => {
          if (!q.options[oi].trim()) { radio.checked = false; toast('Type the choice first', 'error'); return }
          q.answer = q.options[oi]
        }
        choiceList.appendChild(el('div', { class: 'flex items-center gap-2 mb-2' },
          radio,
          el('span', { class: 'text-sm font-bold w-5 ' + dc('text-slate-500', 'text-gray-400') }, String.fromCharCode(65 + oi) + '.'),
          input,
          q.options.length > 2 ? el('button', {
            type: 'button', title: 'Remove choice',
            class: 'w-8 h-8 shrink-0 rounded-lg text-red-500 ' + dc('hover:bg-slate-200', 'hover:bg-gray-700'),
            onclick: () => {
              if (q.answer === q.options[oi]) q.answer = ''
              q.options.splice(oi, 1); drawChoices()
            }
          }, el('i', { class: 'fas fa-xmark' })) : null
        ))
      })
      addChoice.style.display = q.options.length >= 6 ? 'none' : ''
    }
    const choiceList = el('div', {})
    const addChoice = el('button', {
      type: 'button',
      class: 'text-sm font-medium px-3 py-1.5 rounded-lg ' + dc('text-indigo-700 hover:bg-indigo-50', 'text-indigo-400 hover:bg-indigo-900/30'),
      onclick: () => { q.options.push(''); drawChoices() }
    }, el('i', { class: 'fas fa-plus mr-1' }), 'Add choice')
    answerArea.append(choiceList, addChoice)
    drawChoices()
  } else if (q.type === 'true_false') {
    answerArea.appendChild(el('p', { class: 'text-xs font-medium mb-2 ' + dc('text-slate-500', 'text-gray-400') }, 'Correct answer'))
    const row = el('div', { class: 'grid grid-cols-2 gap-2' })
    const btnCls = (v) => 'py-2.5 rounded-lg border text-sm font-semibold ' + (q.answer === v
      ? (v === 'True' ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-red-500 border-red-500 text-white')
      : dc('bg-white border-slate-300 text-slate-700', 'bg-gray-800 border-gray-600 text-gray-200'))
    ;['True', 'False'].forEach((v) => {
      const b = el('button', { type: 'button', class: btnCls(v), onclick: () => {
        q.answer = v
        ;[...row.children].forEach((c) => { c.className = btnCls(c.dataset.v) })
      } }, el('i', { class: 'fas ' + (v === 'True' ? 'fa-check' : 'fa-xmark') + ' mr-1' }), v)
      b.dataset.v = v
      row.appendChild(b)
    })
    answerArea.appendChild(row)
  } else {
    const ans = el('input', { class: inputCls(), placeholder: 'Correct answer (students must type this)' })
    ans.value = q.answer
    ans.oninput = () => { q.answer = ans.value }
    answerArea.appendChild(field('Correct answer', ans))
  }
  card.appendChild(answerArea)

  const expl = el('input', { class: inputCls() + ' mt-3', placeholder: 'Explanation (optional) — shown after answering' })
  expl.value = q.explanation || ''
  expl.oninput = () => { q.explanation = expl.value }
  card.appendChild(expl)
  return card
}

// ---------- AI ----------
function qmAi(draw) {
  const st = qm.ai
  const container = el('div', {})
  container.appendChild(qmHeader('Create quiz with AI', draw))

  const textarea = el('textarea', {
    id: 'qm-ai-text',
    class: 'w-full h-64 border rounded-xl p-4 text-sm resize-y ' + dc('bg-white border-slate-300 focus:border-emerald-500', 'bg-gray-800 border-gray-600 focus:border-emerald-400 text-white placeholder-gray-500'),
    placeholder: 'Copy & paste your questions and choices here. Example:\n\n1. What is the capital of France?\n   A. Berlin  B. Madrid  C. Paris  D. Rome\n2. The heart has four chambers. (True/False)\n3. What gas do plants absorb from the air?\n\nAnswers are optional — if none are provided, the AI will answer them.'
  })
  textarea.value = st.text
  textarea.oninput = () => { st.text = textarea.value }

  const fileInput = el('input', { type: 'file', accept: '.pdf,.txt', class: 'hidden' })
  const uploadBtn = el('button', {
    class: 'flex items-center gap-2 border px-4 py-2 rounded-lg text-sm font-medium ' + dc('border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100', 'border-emerald-700 bg-emerald-900/30 text-emerald-400 hover:bg-emerald-900/50'),
    onclick: () => fileInput.click()
  }, el('i', { class: 'fas fa-file-pdf' }), 'Upload PDF of questions')
  fileInput.onchange = async () => {
    const file = fileInput.files[0]
    if (!file) return
    uploadBtn.innerHTML = '<span class="spinner spinner-dark"></span> Reading file...'
    try {
      const text = file.name.toLowerCase().endsWith('.pdf') ? await pdfToText(file) : await file.text()
      if (!text.trim()) throw new Error('No text found (scanned image PDFs are not supported)')
      st.text = text
      textarea.value = text
      toast('Questions loaded — check them and edit if needed', 'success')
    } catch (e) { toast('Could not read file: ' + e.message, 'error') }
    fileInput.value = ''
    uploadBtn.innerHTML = '<i class="fas fa-file-pdf"></i> Upload PDF of questions'
  }
  const clearBtn = el('button', {
    class: 'text-sm px-3 py-2 rounded-lg ' + dc('text-slate-500 hover:bg-slate-100', 'text-gray-400 hover:bg-gray-700'),
    onclick: () => { st.text = ''; textarea.value = '' }
  }, el('i', { class: 'fas fa-eraser mr-1' }), 'Clear')

  container.appendChild(stepCard('1', 'Paste or upload your questions', el('div', {},
    textarea,
    el('div', { class: 'mt-3 flex flex-wrap items-center gap-2' }, uploadBtn, clearBtn, fileInput),
    el('p', { class: 'mt-3 text-xs flex gap-2 ' + dc('text-slate-500', 'text-gray-400') },
      el('i', { class: 'fas fa-circle-info mt-0.5 text-emerald-600' }),
      'Include the choices if you have them. If the answers are provided (e.g. "Answer: C" or an answer key), the AI will use them. If not, the AI will provide the correct answers.')
  )))

  const titleInput = el('input', { class: inputCls(), placeholder: 'Title (optional — AI will name it if blank)', maxlength: '120' })
  titleInput.value = st.title
  titleInput.oninput = () => { st.title = titleInput.value }
  container.appendChild(stepCard('2', 'Quiz details', el('div', {},
    field('Title', titleInput),
    el('p', { class: 'text-sm font-medium mb-1 ' + dc('text-slate-600', 'text-gray-300') }, 'Difficulty level'),
    qmDifficultyPicker(st)
  )))

  const genBtn = el('button', {
    id: 'qm-ai-btn',
    class: 'w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2'
  }, el('i', { class: 'fas fa-wand-magic-sparkles' }), 'Make quiz with AI')
  const out = el('div', { class: 'mt-4' })
  genBtn.onclick = async () => {
    if (!st.text || st.text.trim().length < 10) return toast('Paste your questions or upload a PDF first', 'error')
    genBtn.disabled = true
    genBtn.innerHTML = '<span class="spinner"></span> AI is reading your questions...'
    try {
      const data = await api('/api/quiz/ai-make', {
        method: 'POST',
        body: JSON.stringify({ text: st.text, title: st.title, difficulty: st.difficulty })
      })
      toast(`Quiz with ${data.questions.length} questions created & saved`, 'success')
      out.innerHTML = ''
      out.appendChild(qmResultCard(data, draw))
      out.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (e) {
      toast(e.message, 'error')
      showAiError(out, e, () => genBtn.click())
    }
    genBtn.disabled = false
    genBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Make quiz with AI'
  }
  container.appendChild(stepCard('3', 'Generate', el('div', {}, genBtn, out)))
  return container
}

// Result card shown after a quiz is saved (manual or AI), with a preview.
function qmResultCard(data) {
  const preview = el('div', { class: 'mt-4 space-y-3 hidden' })
  data.questions.forEach((q, i) => {
    preview.appendChild(el('div', { class: 'rounded-lg border p-3 text-sm ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
      el('div', { class: 'flex items-center gap-2 mb-1' },
        el('span', { class: 'font-bold' }, `Q${i + 1}.`),
        el('span', { class: 'text-[11px] px-2 py-0.5 rounded-full ' + dc('bg-indigo-100 text-indigo-700', 'bg-indigo-900/40 text-indigo-300') }, TYPE_LABELS[q.type] || q.type)),
      el('p', { class: 'mb-1' }, q.question),
      q.options && q.options.length ? el('ul', { class: 'ml-1 mb-1' }, ...q.options.map((o, oi) =>
        el('li', { class: norm(o) === norm(q.answer) ? 'text-emerald-600 font-semibold' : dc('text-slate-600', 'text-gray-300') },
          `${String.fromCharCode(65 + oi)}. ${o}`, norm(o) === norm(q.answer) ? ' ✓' : ''))) : null,
      !q.options || !q.options.length ? el('p', { class: 'text-emerald-600 font-semibold' }, 'Answer: ' + q.answer) : null,
      q.explanation ? el('p', { class: 'text-xs mt-1 ' + dc('text-slate-500', 'text-gray-400') }, q.explanation) : null
    ))
  })
  const toggle = el('button', {
    class: 'text-sm font-medium px-3 py-1.5 rounded-lg ' + dc('text-slate-600 hover:bg-slate-100', 'text-gray-300 hover:bg-gray-700'),
    onclick: () => {
      preview.classList.toggle('hidden')
      toggle.innerHTML = preview.classList.contains('hidden') ? '<i class="fas fa-eye mr-1"></i>Preview questions & answers' : '<i class="fas fa-eye-slash mr-1"></i>Hide preview'
    }
  }, el('i', { class: 'fas fa-eye mr-1' }), 'Preview questions & answers')

  return el('div', { class: 'rounded-xl border p-4 ' + dc('bg-emerald-50 border-emerald-200', 'bg-emerald-900/20 border-emerald-800') },
    el('div', { class: 'flex items-center gap-2 mb-1' },
      el('i', { class: 'fas fa-circle-check text-emerald-600' }),
      el('h3', { class: 'font-semibold' }, data.title)),
    el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' },
      difficultyBadge(data.difficulty),
      el('span', { class: 'text-sm ' + dc('text-slate-600', 'text-gray-300') }, `${data.questions.length} questions`)),
    data.ai_answered ? el('p', { class: 'text-xs mb-3 ' + dc('text-slate-600', 'text-gray-300') },
      el('i', { class: 'fas fa-robot mr-1 text-emerald-600' }),
      `The AI provided the answers for ${data.ai_answered} question${data.ai_answered === 1 ? '' : 's'} that had no answer.`) : null,
    el('div', { class: 'flex flex-wrap gap-2' },
      startQuizBtn(data.share_id),
      shareBtn('/quiz/' + data.share_id),
      toggle),
    preview
  )
}

// ================= PROFILE =================
function profileView() {
  const avatarSrc = me.avatar || defaultAvatar()

  const container = el('div', { class: 'max-w-lg mx-auto' })

  // Profile header card
  const header = el('div', { class: 'text-center mb-6 rounded-2xl border p-6 relative ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('div', { class: 'relative inline-block' },
      el('img', { src: avatarSrc, class: 'w-24 h-24 rounded-full object-cover border-4 ' + dc('border-indigo-100', 'border-indigo-900/50'), id: 'profile-avatar' }),
      // Pencil icon to edit avatar
      el('button', {
        class: 'absolute bottom-0 right-0 w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center shadow-lg hover:bg-indigo-700',
        onclick: () => document.getElementById('avatar-file-input').click()
      }, el('i', { class: 'fas fa-pencil text-xs' }))
    ),
    el('input', { type: 'file', accept: 'image/*', class: 'hidden', id: 'avatar-file-input' }),
    el('h2', { class: 'text-xl font-bold mt-3' }, me.full_name || me.username),
    el('p', { class: 'text-sm ' + dc('text-slate-500', 'text-gray-400') }, '@' + me.username),
    el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') + ' mt-1' }, me.email),
    me.bio ? el('p', { class: 'text-sm mt-2 ' + dc('text-slate-600', 'text-gray-300') }, me.bio) : null
  )

  // Avatar file change handler
  setTimeout(() => {
    const avatarInput = document.getElementById('avatar-file-input')
    if (avatarInput) {
      avatarInput.onchange = () => {
        const f = avatarInput.files[0]; if (!f) return
        const reader = new FileReader()
        reader.onload = async () => {
          me.avatar = reader.result
          const img = document.getElementById('profile-avatar')
          if (img) img.src = me.avatar
          try {
            await api('/api/profile', {
              method: 'PUT',
              body: JSON.stringify({ full_name: me.full_name, username: me.username, birthday: me.birthday, avatar: me.avatar, bio: me.bio })
            })
            toast('Profile picture updated', 'success')
          } catch (e) { toast(e.message, 'error') }
        }
        reader.readAsDataURL(f)
      }
    }
  }, 100)

  container.appendChild(header)

  // My content links
  const myFlashcardsBtn = el('button', {
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-2 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: () => showMyContent('flashcards')
  },
    el('i', { class: 'fas fa-layer-group text-indigo-500' }),
    el('span', { class: 'flex-1 font-medium text-sm' }, 'My Flashcards'),
    el('i', { class: 'fas fa-chevron-right text-xs ' + dc('text-slate-400', 'text-gray-500') })
  )

  const myQuizzesBtn = el('button', {
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-2 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: () => showMyContent('quizzes')
  },
    el('i', { class: 'fas fa-circle-question text-emerald-500' }),
    el('span', { class: 'flex-1 font-medium text-sm' }, 'My Quizzes'),
    el('i', { class: 'fas fa-chevron-right text-xs ' + dc('text-slate-400', 'text-gray-500') })
  )

  const myFriendsBtn = el('button', {
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-2 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: () => showMyFriends()
  },
    el('i', { class: 'fas fa-user-group text-amber-500' }),
    el('span', { class: 'flex-1 font-medium text-sm' }, 'My Friends'),
    el('i', { class: 'fas fa-chevron-right text-xs ' + dc('text-slate-400', 'text-gray-500') })
  )

  // Minimal "Edit Profile" row (opens its own page, like Settings & Privacy)
  const editProfileBtn = el('button', {
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-2 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: () => { view = 'edit-profile'; render() }
  },
    el('i', { class: 'fas fa-user-pen text-sky-500' }),
    el('span', { class: 'flex-1 font-medium text-sm' }, 'Edit Profile'),
    el('i', { class: 'fas fa-chevron-right text-xs ' + dc('text-slate-400', 'text-gray-500') })
  )

  container.append(myFlashcardsBtn, myQuizzesBtn, editProfileBtn, myFriendsBtn)

  // Settings & Privacy
  const settingsBtn = el('button', {
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-2 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: () => { view = 'settings'; render() }
  },
    el('i', { class: 'fas fa-gear ' + dc('text-slate-500', 'text-gray-400') }),
    el('span', { class: 'flex-1 font-medium text-sm' }, 'Settings & Privacy'),
    el('i', { class: 'fas fa-chevron-right text-xs ' + dc('text-slate-400', 'text-gray-500') })
  )
  container.appendChild(settingsBtn)

  // Dark / Light mode toggle
  const themeToggle = el('button', {
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-4 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: async () => {
      const newTheme = isDark() ? 'light' : 'dark'
      applyTheme(newTheme)
      me.theme = newTheme
      try { await api('/api/settings/theme', { method: 'PUT', body: JSON.stringify({ theme: newTheme }) }) } catch(e) {}
      render()
    }
  },
    el('i', { class: isDark() ? 'fas fa-sun text-amber-400' : 'fas fa-moon text-indigo-500' }),
    el('span', { class: 'flex-1 font-medium text-sm' }, isDark() ? 'Switch to Light Mode' : 'Switch to Dark Mode'),
    el('div', { class: `w-11 h-6 rounded-full relative transition-colors ${isDark() ? 'bg-indigo-600' : 'bg-slate-300'}` },
      el('div', { class: `absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${isDark() ? 'left-[1.375rem]' : 'left-0.5'}` })
    )
  )
  container.appendChild(themeToggle)

  // Logout button
  const logoutBtn = el('button', {
    class: 'w-full flex items-center justify-center gap-2 p-4 rounded-xl border border-red-200 text-red-500 hover:bg-red-50 dark:border-red-900/50 dark:hover:bg-red-900/20 font-medium',
    onclick: logout
  }, el('i', { class: 'fas fa-right-from-bracket' }), 'Log Out')
  container.appendChild(logoutBtn)

  return container
}

// ================= EDIT PROFILE (own page, like Settings & Privacy) =================
function editProfileView() {
  const container = el('div', { class: 'max-w-lg mx-auto' })
  // Edit Profile section
  const editSection = el('div', { class: 'rounded-2xl border p-5 mb-4 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') })
  const nameInput = el('input', { class: inputCls(), value: me.full_name || '', placeholder: 'Full name' })
  const unameInput = el('input', { class: inputCls(), value: me.username || '', placeholder: 'Username' })
  const bioInput = el('textarea', {
    class: inputCls() + ' h-20 resize-none',
    placeholder: 'Write a short bio...',
  })
  bioInput.value = me.bio || ''
  const bdayInput = el('input', { type: 'date', class: inputCls(), value: me.birthday || '' })

  const saveBtn = el('button', {
    class: 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg mt-2'
  }, 'Save Profile')
  saveBtn.onclick = async () => {
    saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spinner"></span> Saving...'
    try {
      await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          full_name: nameInput.value, username: unameInput.value,
          birthday: bdayInput.value, avatar: me.avatar, bio: bioInput.value
        })
      })
      me.full_name = nameInput.value; me.username = unameInput.value
      me.birthday = bdayInput.value; me.bio = bioInput.value
      toast('Profile updated', 'success')
      view = 'profile'; render()
    } catch (e) { toast(e.message, 'error') }
    saveBtn.disabled = false; saveBtn.textContent = 'Save Profile'
  }

  editSection.append(
    field('Full name', nameInput),
    field('Username', unameInput),
    field('Bio', bioInput),
    field('Birthday', bdayInput),
    saveBtn
  )

  container.appendChild(editSection)
  return container
}

// ================= SETTINGS & PRIVACY =================
function settingsView() {
  const container = el('div', { class: 'max-w-lg mx-auto' })

  // Change Email
  const emailSection = el('div', { class: 'rounded-2xl border p-5 mb-4 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') })
  const emailInput = el('input', { type: 'email', class: inputCls(), value: me.email, placeholder: 'New email (Gmail only)' })
  const emailPass = el('input', { type: 'password', class: inputCls(), placeholder: 'Current password' })
  const emailBtn = el('button', {
    class: 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg mt-2'
  }, 'Update Email')
  emailBtn.onclick = async () => {
    if (!emailInput.value.toLowerCase().endsWith('@gmail.com'))
      return toast('Only @gmail.com addresses allowed', 'error')
    emailBtn.disabled = true; emailBtn.innerHTML = '<span class="spinner"></span> Updating...'
    try {
      await api('/api/settings/email', {
        method: 'PUT',
        body: JSON.stringify({ email: emailInput.value, password: emailPass.value })
      })
      me.email = emailInput.value
      emailPass.value = ''
      toast('Email updated!', 'success')
    } catch (e) { toast(e.message, 'error') }
    emailBtn.disabled = false; emailBtn.textContent = 'Update Email'
  }
  emailSection.append(
    el('h3', { class: 'font-semibold mb-3 flex items-center gap-2' }, el('i', { class: 'fas fa-envelope' }), 'Change Email'),
    el('p', { class: 'text-xs mb-3 ' + dc('text-slate-400', 'text-gray-500') }, 'Only @gmail.com addresses are accepted'),
    field('New email', emailInput),
    field('Current password', emailPass),
    emailBtn
  )
  container.appendChild(emailSection)

  // Change Password
  const passSection = el('div', { class: 'rounded-2xl border p-5 mb-4 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') })
  const curPass = el('input', { type: 'password', class: inputCls(), placeholder: 'Current password' })
  const newPass = el('input', { type: 'password', class: inputCls(), placeholder: 'New password (min 4 chars)' })
  const confirmPass = el('input', { type: 'password', class: inputCls(), placeholder: 'Confirm new password' })
  const passBtn = el('button', {
    class: 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg mt-2'
  }, 'Update Password')
  passBtn.onclick = async () => {
    if (newPass.value !== confirmPass.value) return toast('Passwords don\'t match', 'error')
    if (newPass.value.length < 4) return toast('Password too short', 'error')
    passBtn.disabled = true; passBtn.innerHTML = '<span class="spinner"></span> Updating...'
    try {
      await api('/api/settings/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: curPass.value, new_password: newPass.value })
      })
      curPass.value = ''; newPass.value = ''; confirmPass.value = ''
      toast('Password updated!', 'success')
    } catch (e) { toast(e.message, 'error') }
    passBtn.disabled = false; passBtn.textContent = 'Update Password'
  }
  passSection.append(
    el('h3', { class: 'font-semibold mb-3 flex items-center gap-2' }, el('i', { class: 'fas fa-lock' }), 'Change Password'),
    field('Current password', curPass),
    field('New password', newPass),
    field('Confirm new password', confirmPass),
    passBtn
  )
  container.appendChild(passSection)

  return container
}

// ================= MY CONTENT MODAL =================
async function showMyContent(type) {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4' })
  const panel = el('div', { class: 'w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[85vh] overflow-y-auto ' + dc('bg-white', 'bg-gray-800') })
  const isFlashcards = type === 'flashcards'

  const headerEl = el('div', { class: 'sticky top-0 p-4 border-b flex items-center justify-between z-10 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('h2', { class: 'font-bold text-lg' }, isFlashcards ? 'My Flashcards' : 'My Quizzes'),
    el('button', { class: dc('text-slate-400 hover:text-slate-600', 'text-gray-400 hover:text-gray-200'), onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times text-xl' }))
  )
  panel.appendChild(headerEl)
  const body = el('div', { class: 'p-4' })
  body.innerHTML = loader('Loading...')
  panel.appendChild(body)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)

  try {
    if (isFlashcards) {
      const { sets } = await api('/api/flashcards')
      body.innerHTML = ''
      if (!sets.length) { body.appendChild(el('p', { class: 'text-center py-6 text-sm ' + dc('text-slate-400', 'text-gray-500') }, 'No flashcards yet')); return }
      sets.forEach(s => {
        const expandBody = el('div', { class: 'mt-3 hidden' })
        expandBody.appendChild(flashcardGrid(s.cards))
        const card = el('div', { class: 'rounded-xl border p-4 mb-3 ' + dc('border-slate-200', 'border-gray-700') },
          el('div', { class: 'flex items-center justify-between' },
            el('div', {},
              el('h4', { class: 'font-semibold text-sm' }, s.title),
              el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `${s.cards.length} cards · ${new Date(s.created_at + 'Z').toLocaleString()}`)
            ),
            el('div', { class: 'flex items-center gap-1' },
              iconBtn('fa-circle-question', 'text-emerald-600', () => { overlay.remove(); openQuizBuilderModal(s) }, 'Make a quiz from these cards'),
              shareBtn('/share/flashcards/' + s.share_id),
              iconBtn('fa-eye', dc('text-slate-500', 'text-gray-400'), () => expandBody.classList.toggle('hidden')),
              iconBtn('fa-trash', 'text-red-500', async () => {
                if (!confirm('Delete this set?')) return
                await api('/api/flashcards/' + s.id, { method: 'DELETE' })
                toast('Deleted', 'success'); overlay.remove()
              })
            )
          ),
          expandBody
        )
        body.appendChild(card)
      })
    } else {
      const { quizzes } = await api('/api/quizzes')
      body.innerHTML = ''
      if (!quizzes.length) { body.appendChild(el('p', { class: 'text-center py-6 text-sm ' + dc('text-slate-400', 'text-gray-500') }, 'No quizzes yet')); return }
      quizzes.forEach(q => {
        const card = el('div', { class: 'rounded-xl border p-4 mb-3 ' + dc('border-slate-200', 'border-gray-700') },
          el('div', { class: 'flex items-center justify-between' },
            el('div', {},
              el('h4', { class: 'font-semibold text-sm' }, q.title),
              el('div', { class: 'flex flex-wrap items-center gap-2 mt-1' },
                difficultyBadge(q.difficulty),
                el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `${q.questions.length} questions · ${q.types.map(t => TYPE_LABELS[t]).join(', ')}`))
            ),
            el('div', { class: 'flex items-center gap-1' },
              iconBtn('fa-play', 'text-emerald-600', () => { location.href = '/quiz/' + q.share_id }, 'Start quiz'),
              iconBtn('fa-chart-simple', 'text-indigo-600', () => showQuizStats(q), 'Stats'),
              shareBtn('/quiz/' + q.share_id),
              iconBtn('fa-trash', 'text-red-500', async () => {
                if (!confirm('Delete this quiz?')) return
                await api('/api/quiz/' + q.id, { method: 'DELETE' })
                toast('Deleted', 'success'); overlay.remove()
              })
            )
          ),
        )
        body.appendChild(card)
      })
    }
  } catch (e) { toast(e.message, 'error') }
}

// ================= MY FRIENDS MODAL =================
async function showMyFriends() {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4' })
  const panel = el('div', { class: 'w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[80vh] overflow-y-auto ' + dc('bg-white', 'bg-gray-800') })

  const headerEl = el('div', { class: 'sticky top-0 p-4 border-b flex items-center justify-between ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('h2', { class: 'font-bold text-lg' }, 'My Friends'),
    el('button', { class: dc('text-slate-400 hover:text-slate-600', 'text-gray-400 hover:text-gray-200'), onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times text-xl' }))
  )
  panel.appendChild(headerEl)
  const body = el('div', { class: 'p-4' })
  body.innerHTML = loader('Loading...')
  panel.appendChild(body)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)

  try {
    const { friends } = await api('/api/friends')
    body.innerHTML = ''
    if (!friends.length) {
      body.appendChild(el('p', { class: 'text-center py-6 text-sm ' + dc('text-slate-400', 'text-gray-500') }, 'No friends yet. Discover people in the Discover tab!'))
      return
    }
    friends.forEach(f => {
      const row = el('div', {
        class: 'flex items-center gap-3 py-3 border-b last:border-0 cursor-pointer ' + dc('border-slate-100 hover:bg-slate-50', 'border-gray-700 hover:bg-gray-750'),
        onclick: () => { overlay.remove(); viewingUserId = f.id; view = 'user-profile'; render() }
      },
        el('img', { src: f.avatar || defaultAvatar(), class: 'w-11 h-11 rounded-full object-cover' }),
        el('div', { class: 'flex-1' },
          el('p', { class: 'font-semibold text-sm' }, f.full_name || f.username),
          el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, '@' + f.username)
        ),
        el('button', {
          class: 'text-xs text-red-400 hover:text-red-500 px-2 py-1',
          onclick: async (e) => {
            e.stopPropagation()
            if (!confirm('Remove friend?')) return
            await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ user_id: f.id }) })
            toast('Friend removed', 'success')
            overlay.remove(); showMyFriends()
          }
        }, el('i', { class: 'fas fa-user-minus' }))
      )
      body.appendChild(row)
    })
  } catch (e) { toast(e.message, 'error') }
}

// ================= SHARED UI =================
function shareBtn(path) {
  return el('button', {
    class: 'flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg ' + dc('bg-slate-100 hover:bg-slate-200 text-slate-600', 'bg-gray-700 hover:bg-gray-600 text-gray-300'),
    onclick: (e) => {
      e.stopPropagation()
      const url = location.origin + path
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ url }).catch(() => {})
      } else {
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
          .then(() => toast('Share link copied!', 'success'))
          .catch(() => prompt('Copy this link:', url))
      }
    }
  }, el('i', { class: 'fas fa-share-nodes' }), 'Share')
}

function iconBtn(icon, color, onclick, title) {
  return el('button', {
    title: title || null,
    class: `w-8 h-8 rounded-lg flex items-center justify-center ${color} ` + dc('hover:bg-slate-100', 'hover:bg-gray-700'),
    onclick: (e) => { e.stopPropagation(); onclick() }
  }, el('i', { class: 'fas ' + icon + ' text-sm' }))
}

function emptyState(icon, title, subtitle) {
  return el('div', { class: 'text-center py-16 rounded-2xl border ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('i', { class: `fas ${icon} text-3xl mb-2 ` + dc('text-slate-300', 'text-gray-600') }),
    el('p', { class: 'font-medium' }, title),
    el('p', { class: 'text-sm ' + dc('text-slate-400', 'text-gray-500') }, subtitle))
}

function inputCls() {
  return 'w-full border rounded-lg px-3 py-2.5 text-sm ' + dc('border-slate-300 bg-white focus:border-indigo-500 text-slate-800', 'border-gray-600 bg-gray-900 focus:border-indigo-400 text-white placeholder-gray-500')
}

function field(label, input) {
  return el('div', { class: 'mb-3' },
    el('label', { class: 'block text-sm font-medium mb-1 ' + dc('text-slate-600', 'text-gray-300') }, label),
    input)
}

function loader(msg) {
  return `<div class="text-center py-10 ${dc('text-slate-400', 'text-gray-500')}"><span class="spinner spinner-dark"></span> ${msg}</div>`
}

function defaultAvatar() {
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23cbd5e1%22%3E%3Cpath d=%22M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z%22/%3E%3C/svg%3E'
}

// Dark/light class helper
function dc(lightCls, darkCls) {
  return isDark() ? darkCls : lightCls
}

function relativeTime(dateStr) {
  const now = Date.now()
  const d = new Date(dateStr + 'Z').getTime()
  const diff = now - d
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr + 'Z').toLocaleDateString()
}

boot()
