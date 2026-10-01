import { api, el, toast, pdfToText, TYPE_LABELS, brandMark, showAiError } from './common.js'

const root = document.getElementById('root')

if (!localStorage.getItem('token') || localStorage.getItem('role') !== 'user') {
  location.href = '/'
}

let me = null
let view = 'home' // home | discover | create | inbox | profile | settings | user-profile | chat
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
    startSocial()
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
  stopChatPolling()
  stopGamePolling()
  root.innerHTML = ''
  if (view === 'chat') { root.appendChild(chatView()); return }
  root.appendChild(el('div', { class: 'min-h-screen flex flex-col pb-20' }, topBar(), mainContent()))
  root.appendChild(bottomNav())
  paintBadges()
}

// ================= TOP BAR =================
function topBar() {
  let title = 'UNSTUDY'
  const isMainTab = ['home', 'create', 'discover', 'inbox', 'profile'].includes(view)
  if (view === 'home') title = 'Home'
  else if (view === 'inbox') title = 'Inbox'
  else if (view === 'create') title = 'Create'
  else if (view === 'discover') title = 'Discover'
  else if (view === 'profile') title = 'Profile'
  else if (view === 'settings') title = 'Settings & Privacy'
  else if (view === 'edit-profile') title = 'Edit Profile'
  else if (view === 'user-profile') title = 'Profile'

  const friendReqBtn = el('button', {
    id: 'friend-requests-btn',
    title: 'Friend requests',
    class: 'relative w-9 h-9 rounded-full flex items-center justify-center ' + dc('hover:bg-slate-100', 'hover:bg-gray-700'),
    onclick: () => showFriendRequests()
  }, el('i', { class: 'fas fa-user-plus text-sm' }), countBadge('badge-friend-requests'))

  // Notification bell (beside the friend request button)
  const notifBtn = el('button', {
    id: 'notifications-btn',
    title: 'Notifications',
    class: 'relative w-9 h-9 rounded-full flex items-center justify-center ' + dc('hover:bg-slate-100', 'hover:bg-gray-700'),
    onclick: () => showNotifications()
  }, el('i', { class: 'fas fa-bell text-sm' }), countBadge('badge-notifications'))

  return el('header', { class: 'sticky top-0 z-30 border-b ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('div', { class: 'max-w-2xl mx-auto px-4 py-3 flex items-center justify-between' },
      el('div', { class: 'flex items-center gap-2' },
        (!isMainTab)
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
        friendReqBtn,
        notifBtn
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
    { id: 'inbox', icon: 'fa-comment-dots', label: 'Inbox' },
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
      el('span', { class: 'relative' },
        el('i', { class: `fas ${item.icon} ${item.id === 'create' ? 'text-2xl' : 'text-lg'}` }),
        item.id === 'inbox' ? countBadge('badge-inbox', '-top-1.5 -right-2.5') : null),
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
  else if (view === 'inbox') loadInbox(wrap)
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
    avatarWithDot(avatarSrc, 'w-10 h-10 border-2 ' + dc('border-slate-100', 'border-gray-600'), !!item.is_online),
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
    avatarWithDot(avatarSrc, 'w-12 h-12', !!u.is_online),
    el('div', { class: 'flex-1 min-w-0' },
      el('p', { class: 'font-semibold text-sm truncate' }, u.full_name || u.username),
      el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `@${u.username}`,
        el('span', { class: 'ml-1 ' + (u.is_online ? 'text-emerald-600 font-medium' : '') }, '· ' + presenceText(u))),
      el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, `${u.flashcard_count} flashcards · ${u.quiz_count} quizzes`)
    ),
    el('div', { class: 'flex items-center gap-1.5 flex-none' },
      friendActionBtn(u),
      messageBtn(u))
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
      el('div', { class: 'inline-block' },
        avatarWithDot(avatarSrc, 'w-24 h-24 border-4 ' + dc('border-indigo-100', 'border-indigo-900/50'), !!u.is_online, 'lg')),
      el('h2', { class: 'text-xl font-bold mt-3' }, u.full_name || u.username),
      el('p', { class: 'text-sm ' + dc('text-slate-500', 'text-gray-400') }, `@${u.username}`),
      el('p', { id: 'profile-presence', class: 'text-xs mt-1 font-medium ' + (u.is_online ? 'text-emerald-600' : dc('text-slate-500', 'text-gray-400')) },
        el('i', { class: 'fas fa-circle text-[7px] mr-1 align-middle ' + (u.is_online ? 'text-emerald-500' : dc('text-slate-300', 'text-gray-600')) }),
        u.is_online ? 'Online now' : lastOnlineText(u.last_seen)),
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
    friendRow.appendChild(el('button', {
      class: 'text-sm font-medium px-4 py-2 rounded-lg ' + dc('bg-slate-100 text-slate-700 hover:bg-slate-200', 'bg-gray-700 text-gray-200 hover:bg-gray-600'),
      onclick: () => openChat(u.id)
    }, el('i', { class: 'fas fa-paper-plane mr-1' }), 'Message'))
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
              toast('Accepted! Say hello in your Inbox 👋', 'success')
              overlay.remove()
              refreshBadges()
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
    else if (qm.mode === 'game') box.appendChild(gameView(draw))
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
      'Paste your questions & choices or upload a PDF. If there are no answers, the AI will answer them and make the quiz.'),
    option('game', 'fa-gamepad', 'bg-amber-500', 'Game',
      'Play a live quiz with others. Join a room with a code, or host your own room with a scheduled start and a leaderboard.')
  )
}

function qmHeader(title, draw) {
  return el('div', { class: 'flex items-center gap-2 mb-4' },
    el('button', {
      class: 'w-9 h-9 rounded-full flex items-center justify-center ' + dc('hover:bg-slate-200 text-slate-600', 'hover:bg-gray-700 text-gray-300'),
      title: 'Back', onclick: () => { if (qm.attachRoom) { qm.mode = 'game'; qm.attachRoom = null } else qm.mode = null; draw() }
    }, el('i', { class: 'fas fa-arrow-left' })),
    el('h2', { class: 'font-bold text-lg' }, title),
    qm.attachRoom ? el('span', { class: 'ml-auto text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800' },
      el('i', { class: 'fas fa-gamepad mr-1' }), 'For room ' + qm.attachRoom) : null)
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
      if (qm.attachRoom) {
        const code = qm.attachRoom
        st.title = ''; st.questions = []
        await attachQuizToRoom(code, data.id)
        qm.attachRoom = null; qm.mode = 'game'; game.tab = 'host'; game.room = code
        draw(); return
      }
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
      if (qm.attachRoom) {
        const code = qm.attachRoom
        await attachQuizToRoom(code, data.id)
        qm.attachRoom = null; qm.mode = 'game'; game.tab = 'host'; game.room = code
        draw(); return
      }
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

// ================= GAME (live quiz rooms) =================
// Create → Quiz Maker → Game:  Join (enter a room code) | Host (create rooms,
// add a quiz, schedule start/close, share the room link, see the leaderboard).
const game = { tab: null, room: null } // tab: null | 'join' | 'host'; room: code being managed
let gameTimer = null
function stopGamePolling() { clearTimeout(gameTimer); gameTimer = null }

const GAME_STATUS = {
  setup: { label: 'Setting up', cls: 'bg-slate-200 text-slate-700', icon: 'fa-screwdriver-wrench' },
  scheduled: { label: 'Waiting room open', cls: 'bg-amber-100 text-amber-800', icon: 'fa-hourglass-half' },
  live: { label: 'Live now', cls: 'bg-emerald-100 text-emerald-800', icon: 'fa-circle-play' },
  closed: { label: 'Closed', cls: 'bg-red-100 text-red-700', icon: 'fa-lock' }
}
function gameStatusBadge(st) {
  const d = GAME_STATUS[st] || GAME_STATUS.setup
  return el('span', { class: 'inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ' + d.cls },
    el('i', { class: 'fas ' + d.icon }), d.label)
}
const roomLink = (code) => location.origin + '/game/' + code
function toLocalInput(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtDateTime = (ms) => ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'
function fmtCountdown(ms) {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d) return `${d}d ${h}h ${m}m`
  if (h) return `${h}h ${m}m ${sec}s`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}
async function attachQuizToRoom(code, quizId) {
  try {
    const r = await api(`/api/game/rooms/${code}/quiz`, { method: 'PUT', body: JSON.stringify({ quiz_id: quizId }) })
    toast(`Room is now "${r.title}"`, 'success')
    return true
  } catch (e) { toast(e.message, 'error'); return false }
}
function copyText(text, okMsg = 'Copied!') {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => toast(okMsg, 'success'))
    .catch(() => prompt('Copy this:', text))
}

function gameView(draw) {
  stopGamePolling()
  const wrap = el('div', { id: 'game-section' })
  const back = el('button', {
    class: 'w-9 h-9 rounded-full flex items-center justify-center ' + dc('hover:bg-slate-200 text-slate-600', 'hover:bg-gray-700 text-gray-300'),
    title: 'Back',
    onclick: () => {
      stopGamePolling()
      if (game.room) game.room = null
      else if (game.tab) game.tab = null
      else qm.mode = null
      draw()
    }
  }, el('i', { class: 'fas fa-arrow-left' }))
  const heading = game.room ? 'Manage room' : game.tab === 'join' ? 'Join a game' : game.tab === 'host' ? 'Host a game' : 'Game'
  wrap.appendChild(el('div', { class: 'flex items-center gap-2 mb-4' }, back,
    el('h2', { class: 'font-bold text-lg flex items-center gap-2' }, el('i', { class: 'fas fa-gamepad text-amber-500' }), heading)))

  if (game.room) wrap.appendChild(gameRoomManager(game.room, draw))
  else if (game.tab === 'join') wrap.appendChild(gameJoinPanel())
  else if (game.tab === 'host') wrap.appendChild(gameHostPanel(draw))
  else {
    const big = (tab, icon, color, title, desc) => el('button', {
      id: 'game-' + tab + '-btn',
      class: 'rounded-2xl border p-5 text-left flex flex-col gap-3 transition hover:shadow-md ' + dc('bg-white border-slate-200 hover:border-indigo-400', 'bg-gray-800 border-gray-700 hover:border-indigo-500'),
      onclick: () => { game.tab = tab; draw() }
    },
      el('span', { class: `w-12 h-12 rounded-xl flex items-center justify-center text-white text-xl ${color}` }, el('i', { class: 'fas ' + icon })),
      el('span', { class: 'block font-bold text-lg' }, title),
      el('span', { class: 'block text-sm ' + dc('text-slate-500', 'text-gray-400') }, desc))
    wrap.appendChild(el('p', { class: 'text-sm mb-4 ' + dc('text-slate-500', 'text-gray-400') }, 'Play a live quiz with friends or classmates.'))
    wrap.appendChild(el('div', { class: 'grid grid-cols-2 gap-3' },
      big('join', 'fa-right-to-bracket', 'bg-indigo-600', 'Join', 'Enter a room code to join an active room.'),
      big('host', 'fa-tower-broadcast', 'bg-amber-500', 'Host', 'Create a room, add a quiz and schedule it.')))
  }
  return wrap
}

// ---------- JOIN ----------
function gameJoinPanel() {
  const input = el('input', {
    id: 'game-code-input',
    class: inputCls() + ' text-center text-2xl font-extrabold tracking-[0.4em] uppercase',
    placeholder: 'CODE', maxlength: '12', autocomplete: 'off', autocapitalize: 'characters'
  })
  input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '') }
  const msg = el('p', { class: 'text-sm mt-2 min-h-[1.25rem] text-red-500' })
  const btn = el('button', { id: 'game-join-submit', class: 'w-full mt-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2' },
    el('i', { class: 'fas fa-right-to-bracket' }), 'Join room')
  const go = async () => {
    const code = input.value.trim()
    msg.textContent = ''
    if (code.length < 4) { msg.textContent = 'Enter the room code (letters only).'; return }
    btn.disabled = true
    try {
      const { room } = await api('/api/game/join/' + code)
      if (room.status === 'closed') { msg.textContent = 'This room is already closed.'; btn.disabled = false; return }
      location.href = '/game/' + room.code
    } catch (e) { msg.textContent = e.message; btn.disabled = false }
  }
  btn.onclick = go
  input.onkeydown = (e) => { if (e.key === 'Enter') go() }
  setTimeout(() => input.focus(), 50)
  return el('div', { class: 'rounded-2xl border p-5 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('p', { class: 'text-sm font-medium mb-2 ' + dc('text-slate-600', 'text-gray-300') }, 'Room code'),
    input, msg, btn,
    el('p', { class: 'text-xs mt-3 text-center ' + dc('text-slate-400', 'text-gray-500') }, 'Ask the host for the room code or the room link.'))
}

// ---------- HOST: room list ----------
function gameHostPanel(draw) {
  const box = el('div', {})
  const createBtn = el('button', { id: 'game-create-room-btn', class: 'w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 mb-5' },
    el('i', { class: 'fas fa-plus' }), 'Create room')
  createBtn.onclick = async () => {
    createBtn.disabled = true
    try {
      const { room } = await api('/api/game/rooms', { method: 'POST' })
      toast('Room ' + room.code + ' created', 'success')
      game.room = room.code; draw()
    } catch (e) { toast(e.message, 'error'); createBtn.disabled = false }
  }
  const list = el('div', { id: 'game-room-list' })
  list.innerHTML = loader('Loading your rooms...')
  box.append(createBtn, el('h3', { class: 'font-semibold mb-2' }, 'My rooms'), list)
  api('/api/game/rooms').then(({ rooms }) => {
    list.innerHTML = ''
    if (!rooms.length) { list.appendChild(el('p', { class: 'text-sm text-center py-8 rounded-xl border border-dashed ' + dc('text-slate-400 border-slate-300', 'text-gray-500 border-gray-600') }, 'No rooms yet. Tap "Create room" to start.')); return }
    rooms.forEach((r) => list.appendChild(el('button', {
      class: 'game-room-card w-full text-left rounded-xl border p-4 mb-3 flex items-center gap-3 ' + dc('bg-white border-slate-200 hover:border-indigo-400', 'bg-gray-800 border-gray-700 hover:border-indigo-500'),
      onclick: () => { game.room = r.code; draw() }
    },
      el('span', { class: 'font-mono font-extrabold tracking-widest text-indigo-600 text-lg w-24 shrink-0' }, r.code),
      el('span', { class: 'flex-1 min-w-0' },
        el('span', { class: 'block font-semibold truncate' }, r.total ? r.title : 'No quiz yet'),
        el('span', { class: 'flex flex-wrap items-center gap-2 mt-1 text-xs ' + dc('text-slate-500', 'text-gray-400') },
          gameStatusBadge(r.status), `${r.players} player${r.players === 1 ? '' : 's'}`, r.start_at ? '· ' + fmtDateTime(r.start_at) : '')),
      el('i', { class: 'fas fa-chevron-right ' + dc('text-slate-400', 'text-gray-500') }))))
  }).catch((e) => { list.innerHTML = ''; toast(e.message, 'error') })
  return box
}

// Sound played whenever a new player joins a room (host view).
// Preloaded up-front (not lazily) so the very first join plays with no
// download delay, and unlocked on the first user interaction so mobile
// autoplay rules don't silently block it.
let joinGameAudio = null
try {
  joinGameAudio = new Audio('/static/joingame.mp3')
  joinGameAudio.preload = 'auto'
  joinGameAudio.load()
  const unlockJoinAudio = () => {
    try {
      joinGameAudio.muted = true
      joinGameAudio.play().then(() => {
        joinGameAudio.pause(); joinGameAudio.currentTime = 0; joinGameAudio.muted = false
      }).catch(() => { joinGameAudio.muted = false })
    } catch (e) {}
  }
  document.addEventListener('pointerdown', unlockJoinAudio, { once: true, capture: true })
  document.addEventListener('keydown', unlockJoinAudio, { once: true, capture: true })
} catch (e) {}
function playJoinSound() {
  try {
    if (!joinGameAudio) { joinGameAudio = new Audio('/static/joingame.mp3'); joinGameAudio.preload = 'auto' }
    const a = joinGameAudio.cloneNode(); a.play().catch(() => {})
  } catch (e) {}
}

// ---------- HOST: manage one room ----------
function gameRoomManager(code, draw) {
  const box = el('div', { id: 'game-room-manager' })
  box.innerHTML = loader('Loading room...')
  let firstPaint = true
  const card = (title, icon, body, id) => el('section', { id, class: 'rounded-2xl border p-4 mb-4 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('h3', { class: 'font-semibold mb-3 flex items-center gap-2' }, el('i', { class: 'fas ' + icon + ' text-indigo-600' }), title), body)

  // live parts updated by polling (status line + leaderboard)
  const statusLine = el('div', { class: 'text-sm mt-2 ' + dc('text-slate-600', 'text-gray-300') })
  const boardBox = el('div', { id: 'game-host-leaderboard' })
  let room = null

  let skew = 0
  const paintStatus = () => {
    if (!room) return
    const t = Date.now() + skew
    statusLine.innerHTML = ''
    statusLine.append(gameStatusBadge(room.status), ' ',
      room.status === 'scheduled' ? `Starts in ${fmtCountdown(room.start_at - t)} · ${fmtDateTime(room.start_at)}`
        : room.status === 'live' ? `Closes in ${fmtCountdown(room.end_at - t)} · ${fmtDateTime(room.end_at)}`
        : room.status === 'closed' ? 'This room is closed.' : 'Add a quiz and set the schedule to open the room.')
  }
  let knownIds = null
  const paintLive = (data) => {
    room = data.room
    skew = room.now - Date.now()
    paintStatus()
    boardBox.innerHTML = ''
    const lb = data.leaderboard
    // 🔊 joingame.mp3 for every new player
    const ids = new Set(lb.map((p) => p.id))
    if (knownIds && [...ids].some((id) => !knownIds.has(id))) playJoinSound()
    knownIds = ids
    if (!lb.length) {
      boardBox.appendChild(el('p', { class: 'text-sm text-center py-6 ' + dc('text-slate-400', 'text-gray-500') }, 'No players yet. Share the room link!'))
      return
    }
    const medal = ['🥇', '🥈', '🥉']
    lb.forEach((p) => {
      boardBox.appendChild(el('div', { class: 'leaderboard-row flex items-center gap-3 py-2.5 border-b last:border-0 ' + dc('border-slate-100', 'border-gray-700') },
        el('span', { class: 'w-8 text-center font-bold' }, medal[p.rank - 1] || '#' + p.rank),
        el('span', { class: 'flex-1 min-w-0' },
          el('span', { class: 'block font-semibold truncate' }, p.name),
          el('span', { class: 'block text-xs ' + dc('text-slate-400', 'text-gray-500') },
            `${p.answered}/${room.total} answered` + (p.finished_at ? ' · finished ' + new Date(p.finished_at).toLocaleTimeString() : room.status === 'scheduled' ? ' · in waiting room' : ''))),
        el('span', { class: 'flex items-center gap-2 text-sm font-extrabold' },
          el('span', { class: 'text-emerald-600' }, '✓ ' + p.score),
          el('span', { class: 'text-red-500' }, '✗ ' + Math.max(0, p.answered - p.score))),
        room.status !== 'closed' ? el('button', {
          title: 'Remove player', class: 'w-7 h-7 rounded-lg text-red-400 ' + dc('hover:bg-slate-100', 'hover:bg-gray-700'),
          onclick: async () => {
            if (!confirm(`Remove ${p.name} from this room?`)) return
            await api(`/api/game/rooms/${code}/players/${p.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'))
            poll(true)
          }
        }, el('i', { class: 'fas fa-xmark text-xs' })) : null))
    })
  }

  const paintAll = (data) => {
    const r = data.room
    const locked = r.status === 'live' || r.status === 'closed'
    box.innerHTML = ''

    // Room header: name (= quiz title) + code
    box.appendChild(el('section', { class: 'rounded-2xl p-5 mb-4 text-white bg-gradient-to-br from-indigo-600 to-violet-600' },
      el('p', { class: 'text-xs uppercase tracking-wider opacity-80' }, 'Room'),
      el('h3', { id: 'game-room-title', class: 'text-xl font-bold break-words' }, r.total ? r.title : 'No quiz yet'),
      el('div', { class: 'flex items-center gap-2 mt-3' },
        el('span', { class: 'text-xs opacity-80' }, 'Code'),
        el('span', { id: 'game-room-code', class: 'font-mono text-3xl font-extrabold tracking-[0.3em]' }, r.code),
        el('button', { class: 'ml-auto text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-lg', onclick: () => copyText(r.code, 'Room code copied!') },
          el('i', { class: 'fas fa-copy mr-1' }), 'Copy')),
      statusLine))

    // 1) Quiz
    const quizBody = el('div', {})
    if (r.total) {
      quizBody.appendChild(el('div', { class: 'flex items-center gap-2 mb-3 flex-wrap' },
        el('i', { class: 'fas fa-circle-check text-emerald-600' }),
        el('span', { class: 'font-semibold' }, r.title),
        difficultyBadge(r.difficulty),
        el('span', { class: 'text-sm ' + dc('text-slate-500', 'text-gray-400') }, `${r.total} questions`)))
    } else {
      quizBody.appendChild(el('p', { class: 'text-sm mb-3 ' + dc('text-slate-500', 'text-gray-400') }, 'Add a quiz first. The quiz title becomes the name of this room.'))
    }
    if (!locked) {
      const opt = (icon, color, label, fn) => el('button', { class: 'flex-1 min-w-[8rem] flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-xl border ' + color, onclick: fn },
        el('i', { class: 'fas ' + icon }), label)
      quizBody.appendChild(el('div', { class: 'flex flex-wrap gap-2' },
        opt('fa-pen-to-square', dc('border-indigo-200 text-indigo-700 hover:bg-indigo-50', 'border-indigo-700 text-indigo-300 hover:bg-indigo-900/30'),
          r.total ? 'Create new manually' : 'Create manually',
          () => { stopGamePolling(); qm.attachRoom = code; qm.mode = 'manual'; draw() }),
        opt('fa-wand-magic-sparkles', dc('border-emerald-200 text-emerald-700 hover:bg-emerald-50', 'border-emerald-700 text-emerald-300 hover:bg-emerald-900/30'),
          'Create with AI',
          () => { stopGamePolling(); qm.attachRoom = code; qm.mode = 'ai'; draw() }),
        opt('fa-file-import', dc('border-amber-200 text-amber-700 hover:bg-amber-50', 'border-amber-700 text-amber-300 hover:bg-amber-900/30'),
          'Import existing quiz',
          () => openQuizPicker(code, () => poll(true, true)))))
    } else {
      quizBody.appendChild(el('p', { class: 'text-xs ' + dc('text-slate-400', 'text-gray-500') }, 'The quiz is locked because the room has started.'))
    }
    box.appendChild(card('1. Quiz', 'fa-circle-question', quizBody, 'game-quiz-step'))

    // 2) Schedule
    const startIn = el('input', { id: 'game-start-at', type: 'datetime-local', class: inputCls() })
    const endIn = el('input', { id: 'game-end-at', type: 'datetime-local', class: inputCls() })
    startIn.value = toLocalInput(r.start_at); endIn.value = toLocalInput(r.end_at)
    if (locked || !r.total) { startIn.disabled = true; endIn.disabled = true }
    const quick = (label, mins) => el('button', {
      type: 'button', class: 'text-xs px-2.5 py-1 rounded-full border ' + dc('border-slate-300 hover:bg-slate-100', 'border-gray-600 hover:bg-gray-700'),
      onclick: () => {
        const s = Date.now() + mins * 60000
        startIn.value = toLocalInput(s)
        if (!endIn.value || new Date(endIn.value).getTime() <= s) endIn.value = toLocalInput(s + 30 * 60000)
      }
    }, label)
    const saveSched = el('button', { id: 'game-save-schedule', class: 'w-full mt-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-xl disabled:opacity-50' },
      el('i', { class: 'fas fa-calendar-check mr-1' }), 'Save schedule')
    if (locked || !r.total) saveSched.disabled = true
    saveSched.onclick = async () => {
      if (!startIn.value || !endIn.value) return toast('Choose both times', 'error')
      saveSched.disabled = true
      try {
        await api(`/api/game/rooms/${code}/schedule`, { method: 'PUT', body: JSON.stringify({ start_at: new Date(startIn.value).getTime(), end_at: new Date(endIn.value).getTime() }) })
        toast('Schedule saved — the waiting room is open!', 'success')
        poll(true, true)
      } catch (e) { toast(e.message, 'error'); saveSched.disabled = false }
    }
    const schedBody = el('div', {},
      !r.total ? el('p', { class: 'text-sm mb-3 text-amber-600' }, 'Add a quiz first, then set the schedule.') : null,
      field('Quiz starts at', startIn),
      !locked && r.total ? el('div', { class: 'flex flex-wrap gap-2 -mt-1 mb-3' }, el('span', { class: 'text-xs ' + dc('text-slate-500', 'text-gray-400') }, 'Quick start:'), quick('in 2 min', 2), quick('in 5 min', 5), quick('in 15 min', 15), quick('in 1 hour', 60)) : null,
      field('Room closes at', endIn),
      saveSched,
      r.status !== 'closed' && r.start_at ? el('button', {
        class: 'w-full mt-2 text-sm font-medium py-2 rounded-xl text-red-500 ' + dc('hover:bg-red-50', 'hover:bg-red-900/20'),
        onclick: async () => {
          if (!confirm('Close this room now? Players will no longer be able to answer.')) return
          await api(`/api/game/rooms/${code}/close`, { method: 'POST' }).catch((e) => toast(e.message, 'error'))
          poll(true, true)
        }
      }, el('i', { class: 'fas fa-lock mr-1' }), 'Close room now') : null)
    if (r.status === 'closed') schedBody.appendChild(reopenBox(r))
    box.appendChild(card('2. Schedule', 'fa-calendar-days', schedBody, 'game-schedule-step'))

    // 3) Room link
    const ready = r.status === 'scheduled' || r.status === 'live'
    const link = roomLink(r.code)
    const linkBody = ready
      ? el('div', {},
          el('div', { id: 'game-room-link', class: 'font-mono text-sm break-all rounded-lg px-3 py-2 mb-3 ' + dc('bg-slate-100', 'bg-gray-900') }, link),
          el('div', { class: 'flex gap-2' },
            el('button', { class: 'flex-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold py-2.5 rounded-xl', onclick: () => copyText(link, 'Room link copied!') },
              el('i', { class: 'fas fa-link mr-1' }), 'Copy link'),
            navigator.share ? el('button', { class: 'flex-1 text-sm font-semibold py-2.5 rounded-xl border ' + dc('border-slate-300', 'border-gray-600'), onclick: () => navigator.share({ title: r.title, text: `Join my Unstudy game "${r.title}" — code ${r.code}`, url: link }).catch(() => {}) },
              el('i', { class: 'fas fa-share-nodes mr-1' }), 'Share') : null,
            el('a', { href: link, target: '_blank', class: 'px-4 text-sm font-semibold py-2.5 rounded-xl border flex items-center ' + dc('border-slate-300', 'border-gray-600') }, el('i', { class: 'fas fa-arrow-up-right-from-square' }))))
      : el('p', { class: 'text-sm ' + dc('text-slate-500', 'text-gray-400') }, r.status === 'closed' ? 'This room is closed.' : 'The room link appears after you add a quiz and save the schedule.')
    box.appendChild(card('3. Room link', 'fa-link', linkBody, 'game-link-step'))

    // 4) Leaderboard
    box.appendChild(card('4. Leaderboard', 'fa-ranking-star', el('div', {},
      el('p', { class: 'text-xs mb-2 ' + dc('text-slate-400', 'text-gray-500') }, 'Highest score first. Same score → whoever finished first. Updates automatically.'),
      boardBox), 'game-leaderboard-step'))

    box.appendChild(el('button', {
      class: 'w-full text-sm font-medium py-2 rounded-xl text-red-500 ' + dc('hover:bg-red-50', 'hover:bg-red-900/20'),
      onclick: async () => {
        if (!confirm('Delete this room and its leaderboard?')) return
        await api('/api/game/rooms/' + code, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'))
        stopGamePolling(); game.room = null; draw()
      }
    }, el('i', { class: 'fas fa-trash mr-1' }), 'Delete room'))
  }

  // Re-open a closed room — the leaderboard / players / answers are kept
  function reopenBox(r) {
    const endIn = el('input', { id: 'game-reopen-end', type: 'datetime-local', class: inputCls() })
    endIn.value = toLocalInput(Date.now() + 30 * 60000)
    const quick = (label, mins) => el('button', {
      type: 'button', class: 'text-xs px-2.5 py-1 rounded-full border ' + dc('border-slate-300 hover:bg-slate-100', 'border-gray-600 hover:bg-gray-700'),
      onclick: () => { endIn.value = toLocalInput(Date.now() + mins * 60000) }
    }, label)
    const btn = el('button', { id: 'game-reopen-btn', class: 'w-full mt-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 rounded-xl disabled:opacity-50' },
      el('i', { class: 'fas fa-lock-open mr-1' }), 'Re-open room')
    btn.onclick = async () => {
      if (!endIn.value) return toast('Choose when the room closes again', 'error')
      btn.disabled = true
      try {
        await api(`/api/game/rooms/${code}/reopen`, { method: 'POST', body: JSON.stringify({ end_at: new Date(endIn.value).getTime() }) })
        toast('Room re-opened — the leaderboard was kept!', 'success')
        poll(true, true)
      } catch (e) { toast(e.message, 'error'); btn.disabled = false }
    }
    return el('div', { class: 'mt-4 pt-4 border-t ' + dc('border-slate-200', 'border-gray-700') },
      el('p', { class: 'text-sm font-semibold mb-1' }, el('i', { class: 'fas fa-rotate-right mr-1 text-emerald-600' }), 'Re-open this room'),
      el('p', { class: 'text-xs mb-3 ' + dc('text-slate-500', 'text-gray-400') }, 'The room opens right away. The leaderboard and everyone\'s answers are kept — players can finish their remaining questions and new players can join.'),
      field('Closes again at', endIn),
      el('div', { class: 'flex flex-wrap gap-2 -mt-1 mb-2' }, quick('+15 min', 15), quick('+30 min', 30), quick('+1 hour', 60), quick('+1 day', 1440)),
      btn)
  }

  let lastStatus = null
  let busy = false
  async function poll(once = false, full = false) {
    if (busy && !full) return
    busy = true
    clearTimeout(gameTimer)
    try {
      const data = await api('/api/game/rooms/' + code)
      if (firstPaint || full || data.room.status !== lastStatus) { paintAll(data); firstPaint = false }
      lastStatus = data.room.status
      paintLive(data)
    } catch (e) {
      if (firstPaint) { busy = false; box.innerHTML = ''; box.appendChild(emptyState('fa-triangle-exclamation', 'Room not found', e.message)); return }
    }
    busy = false
    clearTimeout(gameTimer)
    if (!document.body.contains(box) && !firstPaint) return
    // Poll every 1s while the room is open/scheduled (waiting room) so the
    // joingame.mp3 sound plays the moment a player joins; 3s otherwise.
    const fast = room && room.status === 'scheduled'
    gameTimer = setTimeout(() => poll(), fast ? 1000 : 3000)
  }
  // tick the countdown every second between polls
  const tick = setInterval(() => {
    if (!document.body.contains(box) && !firstPaint) { clearInterval(tick); return }
    paintStatus()
    // status flipped (e.g. scheduled -> live) → refresh right away
    if (room && ((room.status === 'scheduled' && Date.now() + skew >= room.start_at) || (room.status === 'live' && Date.now() + skew >= room.end_at))) poll(true)
  }, 1000)
  poll()
  return box
}

// Pick a quiz for a room: my quizzes + quizzes on the Home feed
async function openQuizPicker(code, done) {
  const { overlay, body } = modal('Import a quiz')
  body.innerHTML = loader('Loading quizzes...')
  try {
    const [{ quizzes: mine }, { feed }] = await Promise.all([api('/api/quizzes'), api('/api/feed')])
    const others = feed.filter((f) => f.content_type === 'quiz' && f.user_id !== me.id)
    body.innerHTML = ''
    const search = el('input', { class: inputCls() + ' mb-3', placeholder: 'Search quizzes...' })
    const listBox = el('div', {})
    body.append(search, listBox)
    const row = (q, by) => {
      const b = el('button', {
        class: 'quiz-pick-row w-full text-left rounded-xl border p-3 mb-2 flex items-center gap-3 ' + dc('border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/40', 'border-gray-700 hover:border-indigo-500 hover:bg-indigo-900/20'),
        onclick: async () => {
          b.disabled = true
          if (await attachQuizToRoom(code, q.id)) { overlay.remove(); done && done() } else b.disabled = false
        }
      },
        el('span', { class: 'w-10 h-10 shrink-0 rounded-lg flex items-center justify-center bg-emerald-600 text-white' }, el('i', { class: 'fas fa-circle-question' })),
        el('span', { class: 'flex-1 min-w-0' },
          el('span', { class: 'block font-semibold text-sm truncate' }, q.title),
          el('span', { class: 'block text-xs ' + dc('text-slate-500', 'text-gray-400') }, `${q.questions.length} questions · ${by}`)),
        el('span', { class: 'text-xs font-semibold text-indigo-600' }, 'Use'))
      b.dataset.title = q.title.toLowerCase()
      return b
    }
    const drawList = () => {
      const term = search.value.trim().toLowerCase()
      listBox.innerHTML = ''
      const sec = (label, items, by) => {
        const f = items.filter((q) => !term || q.title.toLowerCase().includes(term))
        listBox.appendChild(el('p', { class: 'text-xs font-bold uppercase tracking-wide mt-2 mb-2 ' + dc('text-slate-500', 'text-gray-400') }, label))
        if (!f.length) listBox.appendChild(el('p', { class: 'text-sm mb-3 ' + dc('text-slate-400', 'text-gray-500') }, 'No quizzes'))
        f.forEach((q) => listBox.appendChild(row(q, by(q))))
      }
      sec('My quizzes', mine, () => 'by you')
      sec('From the Home feed', others, (q) => 'by ' + (q.full_name || q.username))
    }
    search.oninput = drawList
    drawList()
  } catch (e) { body.innerHTML = ''; toast(e.message, 'error') }
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
      el('span', { class: 'online-dot online-dot-lg', title: 'Online' }),
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
    el('p', { class: 'text-xs mt-1 font-medium text-emerald-600' }, el('i', { class: 'fas fa-circle text-[7px] mr-1 align-middle text-emerald-500' }), 'Online'),
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

  // Phone / desktop notifications
  container.appendChild(notificationSettingRow())

  // Suggest a feature
  container.appendChild(el('button', {
    id: 'suggest-feature-btn',
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-2 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: () => showSuggestModal()
  },
    el('i', { class: 'fas fa-lightbulb text-yellow-500' }),
    el('span', { class: 'flex-1 font-medium text-sm' }, 'Suggest a Feature'),
    el('i', { class: 'fas fa-chevron-right text-xs ' + dc('text-slate-400', 'text-gray-500') })
  ))

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
        avatarWithDot(f.avatar || defaultAvatar(), 'w-11 h-11', !!f.is_online),
        el('div', { class: 'flex-1' },
          el('p', { class: 'font-semibold text-sm' }, f.full_name || f.username),
          el('p', { class: 'text-xs ' + (f.is_online ? 'text-emerald-600' : dc('text-slate-400', 'text-gray-500')) }, '@' + f.username + ' · ' + presenceText(f))
        ),
        el('button', {
          title: 'Message',
          class: 'text-sm text-indigo-600 hover:text-indigo-700 px-2 py-1',
          onclick: (e) => { e.stopPropagation(); overlay.remove(); openChat(f.id) }
        }, el('i', { class: 'fas fa-paper-plane' })),
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

// =====================================================================
// ================= SOCIAL: presence · notifications · inbox ==========
// =====================================================================
let badges = { notifications: 0, friend_requests: 0, unread_chats: 0 }
let known = { notif: null, msg: null } // last ids seen (for new-item alerts)
let pushActive = false
let swReg = null
let badgeTimer = null
let chatUserId = null
let chatTimer = null
let chatReturnView = 'inbox'

// ---------- small UI helpers ----------
function countBadge(id, pos = '-top-0.5 -right-0.5') {
  return el('span', {
    id,
    class: `count-badge hidden absolute ${pos} min-w-[1rem] h-4 px-1 bg-red-500 text-white text-[10px] leading-4 rounded-full text-center font-bold`
  })
}

function paintBadges() {
  const set = (id, n) => {
    const b = document.getElementById(id)
    if (!b) return
    b.textContent = n > 99 ? '99+' : String(n)
    b.classList.toggle('hidden', !n)
  }
  set('badge-notifications', badges.notifications)
  set('badge-friend-requests', badges.friend_requests)
  set('badge-inbox', badges.unread_chats)
}

// Avatar with the green "online" circle (only shown when the user is online)
function avatarWithDot(src, cls = 'w-10 h-10', online = false, size = 'md') {
  return el('span', { class: 'relative inline-block flex-none align-middle' },
    el('img', { src: src || defaultAvatar(), class: 'rounded-full object-cover ' + cls }),
    online ? el('span', { class: 'online-dot' + (size === 'lg' ? ' online-dot-lg' : size === 'sm' ? ' online-dot-sm' : ''), title: 'Online' }) : null)
}

function timeAgoLong(dateStr) {
  if (!dateStr) return ''
  const d = new Date(String(dateStr).replace(' ', 'T') + (String(dateStr).endsWith('Z') ? '' : 'Z')).getTime()
  const secs = Math.max(0, Math.floor((Date.now() - d) / 1000))
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60); if (mins < 60) return unit(mins, 'minute')
  const hrs = Math.floor(mins / 60); if (hrs < 24) return unit(hrs, 'hour')
  const days = Math.floor(hrs / 24); if (days < 7) return unit(days, 'day')
  const weeks = Math.floor(days / 7); if (days < 30) return unit(weeks, 'week')
  const months = Math.floor(days / 30); if (months < 12) return unit(months, 'month')
  return unit(Math.floor(days / 365), 'year')
}
function lastOnlineText(ts) { return ts ? 'Last online ' + timeAgoLong(ts) : 'Offline' }
function presenceText(u) { return u.is_online ? 'Online' : lastOnlineText(u.last_seen) }
function shortTime(dateStr) {
  const d = new Date(String(dateStr).replace(' ', 'T') + 'Z')
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const diff = (now - d) / 86400000
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
function modal(title, opts = {}) {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4' })
  const panel = el('div', { class: 'w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[85vh] overflow-y-auto fade-in ' + dc('bg-white', 'bg-gray-800') })
  const head = el('div', { class: 'sticky top-0 z-10 p-4 border-b flex items-center justify-between gap-2 ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
    el('h2', { class: 'font-bold text-lg' }, title),
    el('div', { class: 'flex items-center gap-2' },
      opts.action || null,
      el('button', { class: dc('text-slate-400 hover:text-slate-600', 'text-gray-400 hover:text-gray-200'), onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times text-xl' }))))
  const body = el('div', { class: 'p-4' })
  panel.append(head, body)
  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
  return { overlay, body }
}

// Discover: message button (right side of "Add Friend")
function messageBtn(u) {
  return el('button', {
    title: u.friend_status === 'friends' ? 'Message' : 'Send a message request',
    class: 'message-btn w-8 h-8 rounded-full flex items-center justify-center border ' + dc('border-indigo-200 text-indigo-600 hover:bg-indigo-50', 'border-indigo-700 text-indigo-300 hover:bg-indigo-900/40'),
    onclick: (e) => { e.stopPropagation(); openChat(u.id) }
  }, el('i', { class: 'fas fa-paper-plane text-xs' }))
}

// ---------- badges / presence polling ----------
async function refreshBadges(background = false) {
  try {
    const d = await api('/api/badges' + (background ? '?bg=1' : ''))
    badges = { notifications: d.notifications || 0, friend_requests: d.friend_requests || 0, unread_chats: d.unread_chats || 0 }
    paintBadges()
    const ln = d.latest_notification, lm = d.latest_message
    if (known.notif !== null && ln && ln.id > known.notif) onNewNotification(ln)
    if (known.msg !== null && lm && lm.id > known.msg) onNewMessage(lm)
    known.notif = ln ? ln.id : 0
    known.msg = lm ? lm.id : 0
  } catch (e) {
    if (e.status === 401) { localStorage.clear(); location.href = '/' }
  }
}

function onNewNotification(n) {
  if (!document.hidden) toast('🔔 ' + n.title, 'info')
  else localNotify(n.title, n.body, '/app?open=notifications', 'notif')
  if (view === 'inbox') render()
}
function onNewMessage(m) {
  const inThisChat = view === 'chat' && Number(chatUserId) === Number(m.sender_id)
  if (!document.hidden) {
    if (!inThisChat) toast(`💬 ${m.name}: ${String(m.body).slice(0, 60)}`, 'info')
    if (view === 'inbox') render()
  } else localNotify(m.name, m.body, '/app?chat=' + m.sender_id, 'chat-' + m.sender_id)
}

// Fallback system notification (used when Web Push is not available)
function localNotify(title, body, url, tag) {
  if (pushActive || !('Notification' in window) || Notification.permission !== 'granted') return
  const opts = { body: String(body || '').slice(0, 200), icon: '/static/logo-192.png', badge: '/static/logo-64.png', tag, data: { url } }
  try {
    if (swReg) swReg.showNotification(title, opts)
    else { const n = new Notification(title, opts); n.onclick = () => { window.focus(); handleOpenUrl(url) } }
  } catch (e) {}
}

function scheduleBadges() {
  clearTimeout(badgeTimer)
  const hidden = document.hidden
  badgeTimer = setTimeout(async () => { await refreshBadges(hidden); scheduleBadges() }, hidden ? 45000 : 15000)
}

function goOffline() {
  const token = localStorage.getItem('token')
  if (!token) return
  try {
    navigator.sendBeacon('/api/presence/offline', new Blob([JSON.stringify({ token })], { type: 'application/json' }))
  } catch (e) {}
}

function startSocial() {
  refreshBadges()
  scheduleBadges()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) goOffline()
    else { refreshBadges(); if (view === 'chat') pollChat() }
    scheduleBadges()
  })
  window.addEventListener('pagehide', goOffline)
  setupServiceWorker()
  setTimeout(maybeAskNotificationPermission, 2500)
  // Deep links (?chat=ID / ?open=notifications / ?open=friend-requests)
  handleOpenUrl(location.href, true)
}

function handleOpenUrl(url, initial = false) {
  try {
    const u = new URL(url, location.origin)
    const chat = u.searchParams.get('chat')
    const open = u.searchParams.get('open')
    if (initial && (chat || open)) history.replaceState(null, '', '/app')
    if (chat) openChat(Number(chat))
    else if (open === 'notifications') showNotifications()
    else if (open === 'friend-requests') showFriendRequests()
    else if (open === 'inbox') { view = 'inbox'; render() }
  } catch (e) {}
}

// ---------- notification permission + push ----------
function urlB64ToUint8Array(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...b].map((c) => c.charCodeAt(0)))
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  try {
    swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'refresh-badges') refreshBadges()
      if (e.data?.type === 'open') handleOpenUrl(e.data.url)
    })
    if ('Notification' in window && Notification.permission === 'granted') await subscribePush()
  } catch (e) { console.warn('Service worker', e) }
}

async function subscribePush() {
  try {
    if (!swReg) swReg = await navigator.serviceWorker.ready
    if (!swReg.pushManager) return false
    let sub = await swReg.pushManager.getSubscription()
    if (!sub) {
      const { publicKey } = await api('/api/push/key')
      sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) })
    }
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) })
    pushActive = true
    return true
  } catch (e) {
    console.warn('Push subscribe failed (in-app + local notifications still work)', e)
    pushActive = false
    return false
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    toast('This browser does not support notifications. On iPhone, add Unstudy to your Home Screen first.', 'error')
    return false
  }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    toast(perm === 'denied' ? 'Notifications are blocked. Allow them in your browser settings.' : 'Notifications not enabled', 'error')
    return false
  }
  if (!swReg) await setupServiceWorker()
  await subscribePush()
  localStorage.removeItem('notif_prompt_dismissed')
  toast('Notifications turned on! 🔔', 'success')
  try { swReg && swReg.showNotification('Notifications are on 🎉', { body: "We'll let you know about messages and updates.", icon: '/static/logo-192.png', tag: 'welcome-notif' }) } catch (e) {}
  return true
}

async function disableNotifications() {
  try {
    const sub = swReg && swReg.pushManager ? await swReg.pushManager.getSubscription() : null
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) })
      await sub.unsubscribe()
    }
  } catch (e) {}
  pushActive = false
  localStorage.setItem('notif_off', '1')
  toast('Notifications turned off on this device', 'info')
}

function maybeAskNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return
  const dismissed = Number(localStorage.getItem('notif_prompt_dismissed') || 0)
  if (Date.now() - dismissed < 3 * 86400000) return
  if (document.getElementById('notif-permission-banner')) return
  const banner = el('div', {
    id: 'notif-permission-banner',
    class: 'fixed left-3 right-3 bottom-20 z-50 max-w-md mx-auto rounded-2xl shadow-2xl border p-4 fade-in ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700')
  },
    el('div', { class: 'flex items-start gap-3' },
      el('div', { class: 'w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center flex-none' }, el('i', { class: 'fas fa-bell' })),
      el('div', { class: 'flex-1 min-w-0' },
        el('p', { class: 'font-semibold text-sm' }, 'Turn on notifications?'),
        el('p', { class: 'text-xs mt-0.5 ' + dc('text-slate-500', 'text-gray-400') }, 'Get notified when you receive a message, a friend request or a new update.'),
        el('div', { class: 'flex gap-2 mt-3' },
          el('button', {
            class: 'text-sm font-semibold px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700',
            onclick: async () => { banner.remove(); await enableNotifications(); if (view === 'profile') render() }
          }, 'Allow'),
          el('button', {
            class: 'text-sm px-4 py-1.5 rounded-lg ' + dc('bg-slate-100 hover:bg-slate-200', 'bg-gray-700 hover:bg-gray-600'),
            onclick: () => { localStorage.setItem('notif_prompt_dismissed', String(Date.now())); banner.remove() }
          }, 'Not now')))))
  document.body.appendChild(banner)
}

function notificationSettingRow() {
  const supported = 'Notification' in window
  const perm = supported ? Notification.permission : 'unsupported'
  const on = perm === 'granted' && localStorage.getItem('notif_off') !== '1'
  const sub = perm === 'denied' ? 'Blocked — allow notifications in your browser settings'
    : perm === 'unsupported' ? 'Not supported on this browser'
    : on ? 'On — you will be notified about messages & updates' : 'Off — tap to turn on'
  return el('button', {
    id: 'notification-setting-btn',
    class: 'w-full flex items-center gap-3 p-4 rounded-xl border mb-2 text-left ' + dc('bg-white border-slate-200 hover:bg-slate-50', 'bg-gray-800 border-gray-700 hover:bg-gray-750'),
    onclick: async () => {
      if (perm === 'denied' || perm === 'unsupported') return toast(sub, 'error')
      if (on) await disableNotifications()
      else { localStorage.removeItem('notif_off'); await enableNotifications() }
      render()
    }
  },
    el('i', { class: 'fas fa-bell text-rose-500' }),
    el('span', { class: 'flex-1' },
      el('span', { class: 'block font-medium text-sm' }, 'Notifications'),
      el('span', { class: 'block text-xs ' + dc('text-slate-500', 'text-gray-400') }, sub)),
    el('div', { class: `w-11 h-6 rounded-full relative transition-colors ${on ? 'bg-indigo-600' : 'bg-slate-300'}` },
      el('div', { class: `absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${on ? 'left-[1.375rem]' : 'left-0.5'}` })))
}

// ---------- notifications panel ----------
const NOTIF_ICONS = {
  welcome: ['fa-hand-sparkles', 'bg-indigo-600'],
  broadcast: ['fa-bullhorn', 'bg-amber-500'],
  friend_accept: ['fa-user-check', 'bg-emerald-500'],
  message_request: ['fa-paper-plane', 'bg-sky-500'],
  system: ['fa-heart', 'bg-pink-500']
}

async function showNotifications() {
  const markAll = el('button', { class: 'text-xs font-medium text-indigo-600 hover:underline' }, 'Mark all read')
  const { overlay, body } = modal('Notifications', { action: markAll })
  body.innerHTML = loader('Loading...')
  const load = async () => {
    try {
      const { notifications } = await api('/api/notifications')
      body.innerHTML = ''
      if (!notifications.length) {
        body.appendChild(el('div', { class: 'text-center py-10' },
          el('i', { class: 'fas fa-bell-slash text-3xl mb-2 ' + dc('text-slate-300', 'text-gray-600') }),
          el('p', { class: 'text-sm ' + dc('text-slate-400', 'text-gray-500') }, "You're all caught up!")))
        return
      }
      notifications.forEach((n) => body.appendChild(notificationRow(n, overlay)))
      body.appendChild(el('button', {
        class: 'w-full mt-3 text-sm font-medium py-2.5 rounded-xl border border-dashed ' + dc('border-indigo-300 text-indigo-600 hover:bg-indigo-50', 'border-indigo-700 text-indigo-300 hover:bg-indigo-900/30'),
        onclick: () => { overlay.remove(); showSuggestModal() }
      }, el('i', { class: 'fas fa-lightbulb mr-1' }), 'Suggest a feature'))
    } catch (e) { toast(e.message, 'error') }
  }
  markAll.onclick = async () => {
    await api('/api/notifications/read-all', { method: 'POST' })
    badges.notifications = 0; paintBadges(); load()
  }
  await load()
}

function notificationRow(n, overlay) {
  const [icon, bg] = NOTIF_ICONS[n.type] || NOTIF_ICONS.system
  const unread = !n.is_read
  const row = el('div', {
    class: 'relative flex items-start gap-3 p-3 rounded-xl mb-2 cursor-pointer transition ' +
      (unread ? dc('bg-indigo-50 hover:bg-indigo-100', 'bg-indigo-900/30 hover:bg-indigo-900/50') : dc('hover:bg-slate-50', 'hover:bg-gray-700')),
    onclick: async () => {
      if (unread) {
        api('/api/notifications/' + n.id + '/read', { method: 'POST' }).catch(() => {})
        badges.notifications = Math.max(0, badges.notifications - 1); paintBadges()
      }
      const link = n.link || ''
      if (link === 'suggest') { overlay.remove(); showSuggestModal() }
      else if (link.startsWith('chat:')) { overlay.remove(); openChat(Number(link.slice(5))) }
      else if (link === 'inbox') { overlay.remove(); view = 'inbox'; render() }
      else { n.is_read = 1; row.replaceWith(notificationRow(n, overlay)) }
    }
  },
    n.actor_avatar
      ? el('img', { src: n.actor_avatar, class: 'w-10 h-10 rounded-full object-cover flex-none' })
      : el('div', { class: `w-10 h-10 rounded-full ${bg} text-white flex items-center justify-center flex-none` }, el('i', { class: 'fas ' + icon })),
    el('div', { class: 'flex-1 min-w-0' },
      el('p', { class: 'text-sm ' + (unread ? 'font-semibold' : 'font-medium') }, n.title),
      n.body ? el('p', { class: 'text-sm mt-0.5 whitespace-pre-line break-words ' + dc('text-slate-600', 'text-gray-300') }, n.body) : null,
      n.type === 'welcome'
        ? el('span', { class: 'inline-flex items-center gap-1 mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 text-white' }, el('i', { class: 'fas fa-lightbulb' }), 'Send a suggestion')
        : null,
      el('p', { class: 'text-[11px] mt-1 ' + dc('text-slate-400', 'text-gray-500') }, relativeTime(n.created_at))),
    unread ? el('span', { class: 'w-2.5 h-2.5 rounded-full bg-indigo-600 flex-none mt-1.5' }) : null)
  return row
}

// ---------- suggest a feature ----------
async function showSuggestModal() {
  const { overlay, body } = modal('Suggest a Feature')
  const input = el('textarea', {
    id: 'suggestion-input',
    rows: 5, maxlength: 2000,
    placeholder: 'What feature would you love to see in Unstudy? Any idea, big or small, is welcome!',
    class: inputCls() + ' resize-y'
  })
  const btn = el('button', { class: 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-xl mt-3 flex items-center justify-center gap-2' },
    el('i', { class: 'fas fa-paper-plane' }), 'Send suggestion')
  const history = el('div', { class: 'mt-5' })
  body.append(
    el('div', { class: 'rounded-xl p-3 mb-3 text-sm ' + dc('bg-indigo-50 text-indigo-900', 'bg-indigo-900/30 text-indigo-100') },
      el('p', { class: 'font-semibold' }, el('i', { class: 'fas fa-person-digging mr-1' }), 'Unstudy is a work in progress'),
      el('p', { class: 'mt-1' }, "We're working on it together with you. Tell us what you want to add or improve — we read every suggestion.")),
    input, btn, history)
  btn.onclick = async () => {
    const text = input.value.trim()
    if (text.length < 3) return toast('Please write your suggestion first', 'error')
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span> Sending...'
    try {
      await api('/api/recommendations', { method: 'POST', body: JSON.stringify({ message: text }) })
      toast('Thank you! Your suggestion was sent 💜', 'success')
      overlay.remove()
      refreshBadges()
    } catch (e) {
      toast(e.message, 'error')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send suggestion'
    }
  }
  setTimeout(() => input.focus(), 100)
  try {
    const { recommendations } = await api('/api/recommendations/mine')
    if (recommendations.length) {
      history.append(el('p', { class: 'text-xs font-semibold uppercase tracking-wide mb-2 ' + dc('text-slate-400', 'text-gray-500') }, 'Your previous suggestions'))
      recommendations.forEach((r) => history.appendChild(el('div', { class: 'text-sm p-3 rounded-lg mb-2 ' + dc('bg-slate-50', 'bg-gray-700') },
        el('p', { class: 'whitespace-pre-line break-words' }, r.message),
        el('p', { class: 'text-[11px] mt-1 ' + dc('text-slate-400', 'text-gray-500') }, relativeTime(r.created_at)))))
    }
  } catch (e) {}
}

// ================= INBOX =================
async function loadInbox(wrap) {
  wrap.innerHTML = loader('Loading inbox...')
  try {
    const data = await api('/api/inbox')
    wrap.innerHTML = ''

    // --- Friends row (top) ---
    const friendsSection = el('section', { id: 'inbox-friends', class: 'mb-5' },
      el('h2', { class: 'text-sm font-semibold mb-2 ' + dc('text-slate-500', 'text-gray-400') }, 'Friends'))
    if (!data.friends.length) {
      friendsSection.appendChild(el('div', { class: 'rounded-2xl border p-5 text-center ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') },
        el('i', { class: 'fas fa-user-group text-3xl mb-2 ' + dc('text-slate-300', 'text-gray-600') }),
        el('p', { class: 'font-medium' }, 'No friends yet'),
        el('p', { class: 'text-sm mb-3 ' + dc('text-slate-400', 'text-gray-500') }, 'Find classmates and study buddies to chat with.'),
        el('button', {
          id: 'go-discover-btn',
          class: 'inline-flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700',
          onclick: () => { view = 'discover'; render() }
        }, el('i', { class: 'fas fa-compass' }), 'Find friends in Discover')))
    } else {
      const row = el('div', { class: 'flex gap-4 overflow-x-auto pb-2 no-scrollbar' })
      data.friends.forEach((f) => row.appendChild(el('button', {
        class: 'flex flex-col items-center gap-1 w-16 flex-none',
        onclick: () => openChat(f.id)
      },
        avatarWithDot(f.avatar, 'w-14 h-14 border-2 ' + (f.is_online ? 'border-emerald-400' : dc('border-slate-200', 'border-gray-600')), f.is_online),
        el('span', { class: 'text-[11px] w-full truncate text-center' }, (f.full_name || f.username).split(' ')[0]))))
      friendsSection.appendChild(row)
    }
    wrap.appendChild(friendsSection)

    // --- Messages ---
    const msgSection = el('section', { id: 'inbox-messages' },
      el('h2', { class: 'text-sm font-semibold mb-2 ' + dc('text-slate-500', 'text-gray-400') }, 'Messages'))

    if (data.requests.length) {
      const reqBox = el('div', { class: 'rounded-2xl border mb-3 overflow-hidden ' + dc('bg-amber-50 border-amber-200', 'bg-amber-900/20 border-amber-800') },
        el('p', { class: 'px-4 pt-3 text-xs font-semibold uppercase tracking-wide ' + dc('text-amber-700', 'text-amber-300') },
          el('i', { class: 'fas fa-envelope-open-text mr-1' }), `Message requests (${data.requests.length})`))
      data.requests.forEach((cv) => reqBox.appendChild(conversationRow(cv, true)))
      msgSection.appendChild(reqBox)
    }

    const list = el('div', { class: 'rounded-2xl border overflow-hidden ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') })
    // Suggested chats: new friends without messages yet
    data.suggested.forEach((f) => list.appendChild(suggestedRow(f)))
    data.conversations.forEach((cv) => list.appendChild(conversationRow(cv)))
    if (!data.suggested.length && !data.conversations.length) {
      list.appendChild(el('div', { class: 'text-center py-10 px-4' },
        el('i', { class: 'fas fa-comments text-3xl mb-2 ' + dc('text-slate-300', 'text-gray-600') }),
        el('p', { class: 'font-medium' }, 'No messages yet'),
        el('p', { class: 'text-sm ' + dc('text-slate-400', 'text-gray-500') },
          data.friends.length ? 'Tap a friend above to start chatting.' : 'Add friends in Discover, or send a message request.')))
    }
    msgSection.appendChild(list)
    wrap.appendChild(msgSection)
  } catch (e) { toast(e.message, 'error'); wrap.innerHTML = '' }
}

function conversationRow(cv, isRequest = false) {
  const u = cv.user
  const unread = cv.unread > 0
  return el('button', {
    class: 'conversation-row w-full flex items-center gap-3 px-4 py-3 text-left border-b last:border-0 ' + dc('border-slate-100 hover:bg-slate-50', 'border-gray-700 hover:bg-gray-700/50'),
    onclick: () => openChat(u.id)
  },
    avatarWithDot(u.avatar, 'w-12 h-12', u.is_online),
    el('div', { class: 'flex-1 min-w-0' },
      el('div', { class: 'flex items-center gap-2' },
        el('p', { class: 'flex-1 text-sm truncate ' + (unread ? 'font-bold' : 'font-semibold') }, u.full_name || u.username),
        el('span', { class: 'text-[11px] flex-none ' + (unread ? 'text-indigo-600 font-semibold' : dc('text-slate-400', 'text-gray-500')) }, shortTime(cv.last_message.created_at))),
      el('div', { class: 'flex items-center gap-2' },
        el('p', { class: 'flex-1 text-xs truncate ' + (unread ? dc('text-slate-900 font-semibold', 'text-white font-semibold') : dc('text-slate-500', 'text-gray-400')) },
          (cv.last_message.from_me ? 'You: ' : '') + cv.last_message.body),
        unread ? el('span', { class: 'min-w-[1.25rem] h-5 px-1.5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center' }, String(cv.unread)) : null),
      isRequest ? el('p', { class: 'text-[11px] mt-0.5 ' + dc('text-amber-700', 'text-amber-300') }, 'Wants to send you a message · tap to reply') : null,
      cv.pending_outgoing ? el('p', { class: 'text-[11px] mt-0.5 ' + dc('text-slate-400', 'text-gray-500') }, 'Message request sent') : null))
}

function suggestedRow(f) {
  const sendHello = async (e) => {
    e.stopPropagation()
    try {
      await api('/api/messages/' + f.id, { method: 'POST', body: JSON.stringify({ body: 'Hello! 👋' }) })
      openChat(f.id)
    } catch (err) { toast(err.message, 'error') }
  }
  return el('div', {
    class: 'suggested-chat w-full flex items-center gap-3 px-4 py-3 cursor-pointer border-b last:border-0 ' + dc('border-slate-100 hover:bg-slate-50', 'border-gray-700 hover:bg-gray-700/50'),
    onclick: () => openChat(f.id)
  },
    avatarWithDot(f.avatar, 'w-12 h-12', f.is_online),
    el('div', { class: 'flex-1 min-w-0' },
      el('p', { class: 'text-sm font-semibold truncate' }, f.full_name || f.username),
      el('p', { class: 'text-xs ' + dc('text-indigo-600', 'text-indigo-300') }, el('i', { class: 'fas fa-sparkles mr-1 fa-wand-magic-sparkles' }), 'New friend · Suggested chat')),
    el('button', {
      class: 'text-xs font-semibold px-3 py-1.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 flex-none',
      onclick: sendHello
    }, 'Say hello 👋'))
}

// ================= CHAT =================
function openChat(uid) {
  if (!uid || Number(uid) === Number(me.id)) return
  document.querySelectorAll('.fixed.inset-0.z-50').forEach((o) => o.remove())
  if (view !== 'chat') chatReturnView = view === 'user-profile' ? 'user-profile' : (['home', 'discover', 'create', 'inbox', 'profile'].includes(view) ? view : 'inbox')
  if (chatReturnView === 'user-profile') viewingUserId = viewingUserId || uid
  chatUserId = Number(uid)
  view = 'chat'
  render()
}

function stopChatPolling() { clearTimeout(chatTimer); chatTimer = null }

let chatState = null
function chatView() {
  const wrap = el('div', { id: 'chat-screen', class: 'chat-screen flex flex-col ' + dc('bg-white', 'bg-gray-900') })
  const header = el('header', { class: 'flex-none flex items-center gap-3 px-3 py-2.5 border-b ' + dc('bg-white border-slate-200', 'bg-gray-800 border-gray-700') })
  const scroller = el('div', { id: 'chat-messages', class: 'flex-1 overflow-y-auto px-3 py-3 flex flex-col' })
  const list = el('div', { class: 'mt-auto flex flex-col gap-1' })
  const banner = el('div', { class: 'flex-none' })
  scroller.appendChild(list)

  const input = el('textarea', {
    id: 'chat-input', rows: 1, maxlength: 2000, placeholder: 'Message...',
    class: 'flex-1 resize-none rounded-3xl px-4 py-2.5 text-sm max-h-32 border ' + dc('bg-slate-100 border-transparent focus:border-indigo-400', 'bg-gray-800 border-gray-700 text-white focus:border-indigo-500')
  })
  const sendBtn = el('button', {
    id: 'chat-send-btn', title: 'Send',
    class: 'w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 flex-none'
  }, el('i', { class: 'fas fa-paper-plane' }))
  const composer = el('footer', { class: 'chat-composer flex-none flex items-end gap-2 px-3 py-2 border-t ' + dc('bg-white border-slate-200', 'bg-gray-900 border-gray-700') }, input, sendBtn)
  wrap.append(header, banner, scroller, composer)

  chatState = { uid: chatUserId, lastId: 0, user: null, list, scroller, header, banner, input, relation: 'friends', seenId: 0, count: 0 }
  header.innerHTML = loader('')

  const autoGrow = () => { input.style.height = 'auto'; input.style.height = Math.min(128, input.scrollHeight) + 'px' }
  input.addEventListener('input', autoGrow)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !/Mobi|Android/i.test(navigator.userAgent)) { e.preventDefault(); send() }
  })
  const send = async (textOverride) => {
    const text = String(textOverride ?? input.value).trim()
    if (!text) return
    sendBtn.disabled = true
    if (textOverride === undefined) { input.value = ''; autoGrow() }
    try {
      const { message, request } = await api('/api/messages/' + chatState.uid, { method: 'POST', body: JSON.stringify({ body: text }) })
      appendMessages([message])
      if (request && chatState.relation === 'none') { chatState.relation = 'request_sent'; paintChatBanner() }
      if (chatState.relation === 'request_received') { chatState.relation = 'accepted'; paintChatBanner() }
    } catch (e) {
      toast(e.message, 'error')
      if (textOverride === undefined) input.value = text
    } finally { sendBtn.disabled = false; input.focus() }
  }
  sendBtn.onclick = () => send()
  chatState.send = send

  pollChat(true)
  return wrap
}

function paintChatHeader() {
  const u = chatState.user
  const { header } = chatState
  header.innerHTML = ''
  header.append(
    el('button', {
      class: 'w-9 h-9 rounded-full flex items-center justify-center flex-none ' + dc('hover:bg-slate-100', 'hover:bg-gray-700'),
      onclick: () => { stopChatPolling(); view = chatReturnView || 'inbox'; render() }
    }, el('i', { class: 'fas fa-arrow-left' })),
    el('button', {
      class: 'flex items-center gap-3 min-w-0 flex-1 text-left',
      onclick: () => { stopChatPolling(); viewingUserId = u.id; view = 'user-profile'; render() }
    },
      avatarWithDot(u.avatar, 'w-10 h-10', u.is_online),
      el('span', { class: 'min-w-0' },
        el('span', { class: 'block font-semibold text-sm truncate' }, u.full_name || u.username),
        el('span', { class: 'block text-xs ' + (u.is_online ? 'text-emerald-600' : dc('text-slate-500', 'text-gray-400')) }, u.is_online ? 'Online now' : lastOnlineText(u.last_seen)))))
}

function paintChatBanner() {
  const { banner, relation, user } = chatState
  banner.innerHTML = ''
  const name = user ? (user.full_name || user.username) : ''
  const box = (cls, ...kids) => el('div', { class: 'px-4 py-2.5 text-xs border-b ' + cls }, ...kids)
  if (relation === 'request_received') {
    banner.appendChild(box(dc('bg-amber-50 border-amber-200 text-amber-900', 'bg-amber-900/20 border-amber-800 text-amber-100'),
      el('p', { class: 'font-semibold' }, `${name} wants to send you a message`),
      el('p', { class: 'mt-0.5' }, 'You are not friends yet. Accept to keep chatting, or decline to remove this request.'),
      el('div', { class: 'flex gap-2 mt-2' },
        el('button', {
          class: 'px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold',
          onclick: async () => { await api(`/api/message-requests/${user.id}/accept`, { method: 'POST' }); chatState.relation = 'accepted'; paintChatBanner(); toast('Request accepted', 'success') }
        }, 'Accept'),
        el('button', {
          class: 'px-3 py-1.5 rounded-lg ' + dc('bg-white border border-amber-300', 'bg-gray-800 border border-amber-700'),
          onclick: async () => { await api(`/api/message-requests/${user.id}/decline`, { method: 'POST' }); toast('Request declined', 'info'); view = 'inbox'; render() }
        }, 'Decline'))))
  } else if (relation === 'request_sent') {
    banner.appendChild(box(dc('bg-slate-50 border-slate-200 text-slate-600', 'bg-gray-800 border-gray-700 text-gray-300'),
      el('i', { class: 'fas fa-clock mr-1' }), `Message request sent. ${name} will see your messages once they accept.`))
  } else if (relation === 'none') {
    banner.appendChild(box(dc('bg-indigo-50 border-indigo-100 text-indigo-800', 'bg-indigo-900/30 border-indigo-800 text-indigo-200'),
      el('i', { class: 'fas fa-circle-info mr-1' }), `You and ${name} are not friends yet — your first message will be sent as a message request.`))
  }
}

function paintChatEmpty() {
  const { list, user } = chatState
  if (chatState.count || list.querySelector('.chat-empty')) return
  const chips = ['Hello! 👋', 'Hi! Want to study together? 📚', 'Hey, nice to meet you! 😊']
  list.appendChild(el('div', { class: 'chat-empty flex flex-col items-center text-center py-8 px-4' },
    el('img', { src: user.avatar || defaultAvatar(), class: 'w-20 h-20 rounded-full object-cover mb-2' }),
    el('p', { class: 'font-semibold' }, user.full_name || user.username),
    el('p', { class: 'text-xs mb-4 ' + dc('text-slate-500', 'text-gray-400') }, '@' + user.username + (chatState.relation === 'friends' ? ' · You are friends on Unstudy' : '')),
    el('p', { class: 'text-xs font-semibold uppercase tracking-wide mb-2 ' + dc('text-slate-400', 'text-gray-500') }, 'Suggested'),
    el('div', { class: 'flex flex-wrap justify-center gap-2' },
      chips.map((t) => el('button', {
        class: 'suggested-chip text-sm px-4 py-2 rounded-full border ' + dc('border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100', 'border-indigo-700 text-indigo-200 bg-indigo-900/30 hover:bg-indigo-900/50'),
        onclick: () => chatState.send(t)
      }, t)))))
}

function appendMessages(msgs) {
  const { list, scroller, user } = chatState
  if (!msgs.length) return
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
  list.querySelector('.chat-empty')?.remove()
  for (const m of msgs) {
    if (m.id <= chatState.lastId) continue
    // Day separator
    const day = new Date(String(m.created_at).replace(' ', 'T') + 'Z').toDateString()
    if (day !== chatState.lastDay) {
      chatState.lastDay = day
      const d = new Date(day)
      const label = day === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      list.appendChild(el('p', { class: 'text-center text-[11px] my-2 ' + dc('text-slate-400', 'text-gray-500') }, label))
    }
    const mine = Number(m.sender_id) === Number(me.id)
    const bubble = el('div', {
      class: 'chat-bubble max-w-[75%] px-3.5 py-2 text-sm whitespace-pre-wrap break-words rounded-3xl ' +
        (mine ? 'bg-indigo-600 text-white rounded-br-md' : dc('bg-slate-100 text-slate-900', 'bg-gray-800 text-gray-100') + ' rounded-bl-md'),
      title: new Date(String(m.created_at).replace(' ', 'T') + 'Z').toLocaleString()
    }, m.body)
    // Their profile picture on the left of every message they send (like Instagram)
    const row = mine
      ? el('div', { class: 'chat-row flex justify-end', 'data-id': m.id }, bubble)
      : el('div', { class: 'chat-row flex items-end gap-2', 'data-id': m.id },
          el('img', { src: user.avatar || defaultAvatar(), class: 'chat-avatar w-7 h-7 rounded-full object-cover flex-none' }), bubble)
    list.appendChild(row)
    chatState.lastId = m.id
    chatState.count++
  }
  paintSeen()
  if (nearBottom || msgs.some((m) => Number(m.sender_id) === Number(me.id))) scroller.scrollTop = scroller.scrollHeight
}

function paintSeen() {
  const { list } = chatState
  list.querySelector('.chat-seen')?.remove()
  const mineRows = [...list.querySelectorAll('.chat-row.justify-end')]
  const last = mineRows[mineRows.length - 1]
  if (!last) return
  const lastId = Number(last.dataset.id)
  const allRows = list.querySelectorAll('.chat-row')
  const isLastOverall = allRows[allRows.length - 1] === last
  if (!isLastOverall) return
  last.after(el('p', { class: 'chat-seen text-right text-[11px] pr-1 ' + dc('text-slate-400', 'text-gray-500') },
    chatState.seenId >= lastId ? 'Seen' : 'Sent'))
}

async function pollChat(first = false) {
  if (!chatState || view !== 'chat') return
  stopChatPolling()
  const uid = chatState.uid
  try {
    const d = await api(`/api/messages/${uid}?after=${first ? 0 : chatState.lastId}`)
    if (!chatState || chatState.uid !== uid || view !== 'chat') return
    const firstLoad = !chatState.user
    chatState.user = d.user
    chatState.seenId = d.seen_id || 0
    const relChanged = chatState.relation !== d.relation
    chatState.relation = d.relation
    paintChatHeader()
    if (firstLoad || relChanged) paintChatBanner()
    appendMessages(d.messages)
    if (firstLoad) {
      paintChatEmpty()
      chatState.scroller.scrollTop = chatState.scroller.scrollHeight
      if (!/Mobi|Android/i.test(navigator.userAgent)) chatState.input.focus()
      refreshBadges()
    } else paintSeen()
  } catch (e) {
    if (e.status === 404) { toast('User not found', 'error'); view = 'inbox'; render(); return }
  }
  if (view === 'chat') chatTimer = setTimeout(() => pollChat(), document.hidden ? 15000 : 3000)
}

boot()
