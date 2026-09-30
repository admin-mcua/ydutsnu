import { api, el, toast, logoImg } from './common.js'

const root = document.getElementById('root')

if (!localStorage.getItem('token') || localStorage.getItem('role') !== 'admin') {
  location.href = '/'
}

function logout() {
  api('/api/logout', { method: 'POST' }).finally(() => {
    localStorage.clear()
    location.href = '/'
  })
}

const TABS = ['accounts', 'recommendations', 'notify', 'keys']
let tab = TABS.includes(new URLSearchParams(location.search).get('tab')) ? new URLSearchParams(location.search).get('tab') : 'accounts'

async function boot() {
  root.innerHTML = ''
  root.appendChild(el('header', { class: 'bg-slate-900 text-white' },
    el('div', { class: 'max-w-6xl mx-auto px-4 py-3 flex items-center justify-between' },
      el('div', { class: 'font-bold flex items-center gap-2' },
        logoImg(28), el('span', {}, 'UNSTUDY Admin')),
      el('div', { class: 'flex items-center gap-3' },
        // Upload / Restore button
        el('button', {
          class: 'text-sm bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 px-3 py-1.5 rounded-lg flex items-center gap-2',
          onclick: () => openRestoreDialog()
        }, el('i', { class: 'fas fa-upload' }), el('span', { class: 'hidden sm:inline' }, 'Restore Account')),
        // Logout
        el('button', { class: 'text-sm bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg', onclick: logout },
          el('i', { class: 'fas fa-right-from-bracket mr-1' }), 'Log out')
      )
    ),
    // Section tabs
    el('nav', { id: 'admin-tabs', class: 'max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto whitespace-nowrap' },
      tabBtn('accounts', 'fa-users', 'Accounts'),
      tabBtn('recommendations', 'fa-lightbulb', 'Recommendations'),
      tabBtn('notify', 'fa-bullhorn', 'Notify All'),
      tabBtn('keys', 'fa-key', 'API Keys'))
  ))

  const container = el('main', { class: 'max-w-6xl mx-auto px-4 py-6' })
  root.appendChild(container)
  loadAdminBadges()
  if (tab === 'keys') return renderApiKeys(container)
  if (tab === 'recommendations') return renderRecommendations(container)
  if (tab === 'notify') return renderBroadcast(container)
  container.innerHTML = '<div class="text-center py-10 text-slate-400"><span class="spinner spinner-dark"></span> Loading accounts...</div>'

  try {
    const { users } = await api('/api/admin/users')
    container.innerHTML = ''
    container.appendChild(el('div', { class: 'flex items-center justify-between mb-4' },
      el('h1', { class: 'text-xl font-bold' }, 'Registered Accounts'),
      el('span', { class: 'text-sm text-slate-500' }, users.length + ' total')
    ))

    if (!users.length) {
      container.appendChild(el('div', { class: 'text-center py-16 text-slate-400 bg-white rounded-2xl border' }, 'No accounts yet.'))
      return
    }

    const grid = el('div', { class: 'grid md:grid-cols-2 gap-4' })
    users.forEach((u) => grid.appendChild(userCard(u, container)))
    container.appendChild(grid)
  } catch (e) {
    toast(e.message, 'error')
    container.innerHTML = '<p class="text-red-500 text-center py-10">' + e.message + '</p>'
  }
}

function tabBtn(id, icon, label) {
  const active = tab === id
  return el('button', {
    id: 'tab-' + id,
    class: 'px-4 py-2.5 text-sm font-medium rounded-t-lg flex items-center gap-2 ' +
      (active ? 'bg-slate-100 text-slate-900' : 'text-white/70 hover:text-white hover:bg-white/10'),
    onclick: () => {
      tab = id
      history.replaceState(null, '', id === 'accounts' ? '/admin' : '/admin?tab=' + id)
      boot()
    }
  }, el('i', { class: 'fas ' + icon }), label,
    id === 'recommendations' ? el('span', { id: 'admin-badge-recs', class: 'hidden ml-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[10px] leading-[1.1rem] text-center font-bold' }) : null)
}

async function loadAdminBadges() {
  try {
    const d = await api('/api/admin/summary')
    const b = document.getElementById('admin-badge-recs')
    if (b) { b.textContent = String(d.new_recommendations || 0); b.classList.toggle('hidden', !d.new_recommendations) }
  } catch (e) {}
}

const fmtDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString()
const defAvatar = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23cbd5e1%22%3E%3Cpath d=%22M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z%22/%3E%3C/svg%3E'

// ================= RECOMMENDATIONS (sent by users) =================
async function renderRecommendations(container) {
  container.innerHTML = '<div class="text-center py-10 text-slate-400"><span class="spinner spinner-dark"></span> Loading recommendations...</div>'
  try {
    const { recommendations } = await api('/api/admin/recommendations')
    container.innerHTML = ''
    const newCount = recommendations.filter((r) => r.status === 'new').length
    let filter = 'all'
    const list = el('div', { id: 'recommendations-list', class: 'space-y-3' })
    const filterBtn = (id, label) => el('button', {
      class: 'rec-filter text-xs font-semibold px-3 py-1.5 rounded-full border',
      'data-f': id,
      onclick: () => { filter = id; draw() }
    }, label)
    container.append(
      el('div', { class: 'flex flex-wrap items-center justify-between gap-3 mb-4' },
        el('div', {},
          el('h1', { class: 'text-xl font-bold' }, 'Feature Recommendations'),
          el('p', { class: 'text-sm text-slate-500' }, `${recommendations.length} total · ${newCount} new — suggestions sent by users from the app`)),
        el('div', { class: 'flex items-center gap-2' },
          filterBtn('all', 'All'), filterBtn('new', 'New'), filterBtn('seen', 'Seen'),
          newCount ? el('button', {
            class: 'text-xs font-semibold px-3 py-1.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-700',
            onclick: async () => { await api('/api/admin/recommendations/mark-all-seen', { method: 'POST' }); boot() }
          }, el('i', { class: 'fas fa-check-double mr-1' }), 'Mark all seen') : null)),
      list)

    function draw() {
      container.querySelectorAll('.rec-filter').forEach((b) => {
        b.className = 'rec-filter text-xs font-semibold px-3 py-1.5 rounded-full border ' +
          (b.dataset.f === filter ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50')
      })
      list.innerHTML = ''
      const items = recommendations.filter((r) => filter === 'all' || r.status === filter)
      if (!items.length) {
        list.appendChild(el('div', { class: 'text-center py-16 text-slate-400 bg-white rounded-2xl border' },
          el('i', { class: 'fas fa-lightbulb text-3xl mb-2 block' }), 'No recommendations yet.'))
        return
      }
      items.forEach((r) => {
        const isNew = r.status === 'new'
        const card = el('article', { class: 'bg-white rounded-2xl border p-4 flex gap-3 ' + (isNew ? 'border-indigo-300 ring-1 ring-indigo-100' : 'border-slate-200') },
          el('img', { src: r.avatar || defAvatar, class: 'w-11 h-11 rounded-full object-cover flex-none bg-slate-100' }),
          el('div', { class: 'flex-1 min-w-0' },
            el('div', { class: 'flex flex-wrap items-center gap-x-2 gap-y-0.5' },
              el('span', { class: 'font-semibold text-sm' }, r.username ? (r.full_name || r.username) : 'Deleted account'),
              r.username ? el('span', { class: 'text-xs text-slate-500' }, '@' + r.username) : null,
              r.email ? el('span', { class: 'text-xs text-slate-400' }, '· ' + r.email) : null,
              isNew ? el('span', { class: 'text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-indigo-600 text-white' }, 'New') : null),
            el('p', { class: 'text-sm text-slate-800 mt-1.5 whitespace-pre-line break-words' }, r.message),
            el('p', { class: 'text-xs text-slate-400 mt-2' }, el('i', { class: 'far fa-clock mr-1' }), fmtDate(r.created_at))),
          el('div', { class: 'flex flex-col gap-1 flex-none' },
            el('button', {
              title: isNew ? 'Mark as seen' : 'Mark as new',
              class: 'w-8 h-8 rounded-lg hover:bg-slate-100 ' + (isNew ? 'text-emerald-600' : 'text-slate-400'),
              onclick: async () => { await api('/api/admin/recommendations/' + r.id, { method: 'PUT', body: JSON.stringify({ status: isNew ? 'seen' : 'new' }) }); r.status = isNew ? 'seen' : 'new'; draw(); loadAdminBadges() }
            }, el('i', { class: 'fas ' + (isNew ? 'fa-check' : 'fa-rotate-left') })),
            el('button', {
              title: 'Delete',
              class: 'w-8 h-8 rounded-lg hover:bg-red-50 text-red-500',
              onclick: async () => {
                if (!confirm('Delete this recommendation?')) return
                await api('/api/admin/recommendations/' + r.id, { method: 'DELETE' })
                recommendations.splice(recommendations.indexOf(r), 1); draw(); loadAdminBadges()
              }
            }, el('i', { class: 'fas fa-trash' }))))
        list.appendChild(card)
      })
    }
    draw()
  } catch (e) {
    toast(e.message, 'error')
    container.innerHTML = '<p class="text-red-500 text-center py-10">' + e.message + '</p>'
  }
}

// ================= NOTIFY ALL USERS =================
async function renderBroadcast(container) {
  container.innerHTML = ''
  const titleInput = el('input', {
    id: 'broadcast-title', maxlength: 120, value: '',
    placeholder: 'Title (optional) — e.g. New feature is here! 🎉',
    class: 'w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:border-indigo-500'
  })
  const msgInput = el('textarea', {
    id: 'broadcast-message', rows: 5, maxlength: 2000,
    placeholder: 'Type the message to send to all users...',
    class: 'w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:border-indigo-500 resize-y'
  })
  const counter = el('span', { class: 'text-xs text-slate-400' }, '0 / 2000')
  msgInput.oninput = () => { counter.textContent = msgInput.value.length + ' / 2000' }
  const sendBtn = el('button', {
    id: 'broadcast-send-btn',
    class: 'bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-2.5 rounded-lg flex items-center gap-2 disabled:opacity-60'
  }, el('i', { class: 'fas fa-paper-plane' }), 'Send to all users')
  const history = el('div', { class: 'space-y-2' })

  sendBtn.onclick = async () => {
    const message = msgInput.value.trim()
    if (!message) return toast('Type a message first', 'error')
    if (!confirm('Send this notification to ALL users?')) return
    sendBtn.disabled = true
    sendBtn.innerHTML = '<span class="spinner"></span> Sending...'
    try {
      const r = await api('/api/admin/broadcast', { method: 'POST', body: JSON.stringify({ title: titleInput.value.trim(), message }) })
      toast(`Sent to ${r.recipients} user${r.recipients === 1 ? '' : 's'}!`, 'success')
      titleInput.value = ''; msgInput.value = ''; counter.textContent = '0 / 2000'
      loadHistory()
    } catch (e) { toast(e.message, 'error') }
    sendBtn.disabled = false
    sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send to all users'
  }

  container.append(
    el('h1', { class: 'text-xl font-bold mb-1' }, 'Notify All Users'),
    el('p', { class: 'text-sm text-slate-500 mb-4' }, 'Your message appears in every user\'s notifications (bell icon). Users who allowed notifications also get a phone / desktop notification.'),
    el('section', { class: 'bg-white rounded-2xl border p-5 mb-6' },
      el('label', { class: 'block text-sm font-medium mb-1' }, 'Title'), titleInput,
      el('label', { class: 'block text-sm font-medium mb-1 mt-3' }, 'Message'), msgInput,
      el('div', { class: 'flex items-center justify-between mt-3' }, counter, sendBtn)),
    el('h2', { class: 'font-semibold mb-2' }, 'Sent announcements'),
    history)

  async function loadHistory() {
    history.innerHTML = '<p class="text-sm text-slate-400">Loading...</p>'
    try {
      const { broadcasts } = await api('/api/admin/broadcasts')
      history.innerHTML = ''
      if (!broadcasts.length) return history.appendChild(el('p', { class: 'text-sm text-slate-400' }, 'Nothing sent yet.'))
      broadcasts.forEach((b) => history.appendChild(el('div', { class: 'bg-white rounded-xl border p-4' },
        el('div', { class: 'flex items-center justify-between gap-2' },
          el('p', { class: 'font-semibold text-sm' }, b.title),
          el('span', { class: 'text-xs text-slate-400' }, fmtDate(b.created_at))),
        el('p', { class: 'text-sm text-slate-700 mt-1 whitespace-pre-line break-words' }, b.body),
        el('p', { class: 'text-xs text-slate-400 mt-1' }, el('i', { class: 'fas fa-users mr-1' }), `${b.recipients} recipients`))))
    } catch (e) { history.innerHTML = '' }
  }
  loadHistory()
}

// ================= API KEYS (Gemini, round-robin) =================
async function renderApiKeys(container) {
  container.innerHTML = '<div class="text-center py-10 text-slate-400"><span class="spinner spinner-dark"></span> Loading API keys...</div>'
  let data
  try { data = await api('/api/admin/api-keys') } catch (e) {
    container.innerHTML = '<p class="text-red-500 text-center py-10">' + e.message + '</p>'; return
  }
  container.innerHTML = ''
  const keys = data.keys
  const current = keys.find((k) => k.id === data.current_id)
  const nextK = keys.find((k) => k.id === data.next_id)
  const activeKeys = keys.filter((k) => k.active)

  container.appendChild(el('div', { class: 'flex items-center justify-between mb-4 gap-3 flex-wrap' },
    el('div', {},
      el('h1', { class: 'text-xl font-bold' }, 'Gemini API Keys'),
      el('p', { class: 'text-sm text-slate-500' }, 'Round-robin load balancing: every new AI request uses the next key (A → B → C → A ...).')),
    el('button', {
      id: 'add-key-btn',
      class: 'bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2',
      onclick: () => openAddKeyDialog()
    }, el('i', { class: 'fas fa-plus' }), 'Add API key')))

  // Resilience features applied to every key
  const chip = (icon, text) => el('span', { class: 'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-800' }, el('i', { class: 'fas ' + icon }), text)
  container.appendChild(el('section', { id: 'resilience-info', class: 'bg-white border rounded-2xl p-4 mb-5' },
    el('p', { class: 'text-sm font-semibold mb-2' }, el('i', { class: 'fas fa-shield-halved mr-1 text-indigo-600' }), 'Applied to every key'),
    el('div', { class: 'flex flex-wrap gap-2' },
      chip('fa-layer-group', 'Model fallback: ' + (data.models || ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest']).join(' → ')),
      chip('fa-clock-rotate-left', 'Exponential backoff + jitter (429 / 5xx)'),
      chip('fa-gauge-high', 'thinkingLevel: LOW (Gemini 3)'),
      chip('fa-code-branch', 'Dual-batch 25 + 25 for large sets'),
      chip('fa-comment-dots', 'Friendly error messages'))))

  // Current status
  container.appendChild(el('section', { id: 'current-key', class: 'grid sm:grid-cols-3 gap-3 mb-5' },
    statBox('fa-bolt', 'Currently using', current ? current.label : (activeKeys[0] ? activeKeys[0].label : 'None'),
      current ? current.api_key : (activeKeys[0] ? activeKeys[0].api_key : 'Add a key')),
    statBox('fa-forward', 'Next request uses', nextK ? nextK.label : '—', nextK ? nextK.api_key : ''),
    statBox('fa-rotate', 'Keys in rotation', `${activeKeys.length} active`, `${data.total_requests} total AI requests`)))

  // Rotation preview
  if (activeKeys.length) {
    const start = data.total_requests
    const prev = el('div', { class: 'bg-white border rounded-2xl p-4 mb-5' },
      el('p', { class: 'text-sm font-semibold mb-2' }, el('i', { class: 'fas fa-arrows-spin mr-1 text-indigo-600' }), 'Upcoming requests'),
      el('div', { class: 'flex flex-wrap gap-2' },
        ...Array.from({ length: Math.max(4, Math.min(8, activeKeys.length * 2)) }, (_, i) => {
          const k = activeKeys[(start + i) % activeKeys.length]
          return el('span', { class: 'text-xs px-2.5 py-1 rounded-full ' + (i === 0 ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700') },
            `Request ${start + i + 1} → ${k.label}`)
        })))
    container.appendChild(prev)
  }

  if (!keys.length) {
    container.appendChild(el('div', { class: 'text-center py-12 text-slate-500 bg-white rounded-2xl border' },
      'No API keys yet. Click "Add API key".'))
    return
  }

  const list = el('div', { class: 'space-y-3' })
  keys.forEach((k) => {
    const ok = (k.last_status || '').startsWith('ok')
    const isCurrent = current && k.id === current.id
    const statusBadge = el('span', { class: 'text-[11px] font-semibold px-2 py-0.5 rounded-full ' + (ok ? 'bg-emerald-100 text-emerald-800' : k.last_status ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700') },
      ok ? 'Working' : (k.last_status ? 'Error' : 'Unchecked'))
    const labelTitle = el('h3', { class: 'api-key-label font-semibold break-all' }, k.label)
    const titleRow = el('div', { class: 'flex items-center gap-2 flex-wrap' })
    const editBtn = el('button', {
      type: 'button',
      class: 'api-key-rename absolute top-2 right-2 w-8 h-8 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 flex items-center justify-center',
      title: 'Rename ' + k.label,
      'aria-label': 'Rename ' + k.label,
      onclick: () => startRename(k, titleRow, labelTitle, editBtn, container)
    }, el('i', { class: 'fas fa-pen text-sm' }))
    const row = el('article', { 'data-key-id': k.id, class: 'api-key-card relative bg-white border rounded-2xl p-4 pr-12 flex items-center gap-4 flex-wrap ' + (isCurrent ? 'ring-2 ring-indigo-500' : '') },
      editBtn,
      el('div', { class: 'w-12 h-12 shrink-0 rounded-xl flex items-center justify-center font-bold ' + (badgeText(k.label).length > 1 ? 'text-base ' : 'text-lg ') + (k.active ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500') },
        badgeText(k.label)),
      el('div', { class: 'flex-1 min-w-[200px]' },
        fill(titleRow,
          labelTitle,
          statusBadge,
          isCurrent ? el('span', { class: 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800' }, 'In use') : null,
          !k.active ? el('span', { class: 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700' }, 'Paused') : null),
        el('p', { class: 'font-mono text-sm text-slate-700 mt-0.5' }, k.api_key),
        el('p', { class: 'text-xs text-slate-500 mt-0.5' },
          `${k.uses} requests · last used ${k.last_used_at ? new Date(k.last_used_at + 'Z').toLocaleString() : 'never'}`),
        !ok && k.last_status ? el('p', { class: 'text-xs text-red-600 mt-0.5 break-all' }, k.last_status) : null),
      el('div', { class: 'flex items-center gap-1' },
        el('button', {
          class: 'text-sm px-3 py-1.5 rounded-lg border hover:bg-slate-50 flex items-center gap-1',
          onclick: async (e) => {
            const b = e.currentTarget
            b.disabled = true; b.innerHTML = '<span class="spinner spinner-dark"></span>'
            try {
              const r = await api('/api/admin/api-keys/' + k.id + '/test', { method: 'POST' })
              toast(r.ok ? `${k.label} is working` + (r.model ? ` (${r.model})` : '') : `${k.label} failed: ${r.error}`, r.ok ? 'success' : 'error')
            } catch (err) { toast(err.message, 'error') }
            renderApiKeys(container)
          }
        }, el('i', { class: 'fas fa-stethoscope' }), 'Test'),
        el('button', {
          class: 'text-sm px-3 py-1.5 rounded-lg border hover:bg-slate-50',
          title: k.active ? 'Pause (remove from rotation)' : 'Resume (add back to rotation)',
          onclick: async () => {
            await api('/api/admin/api-keys/' + k.id, { method: 'PUT', body: JSON.stringify({ active: !k.active }) })
            renderApiKeys(container)
          }
        }, el('i', { class: 'fas ' + (k.active ? 'fa-pause' : 'fa-play') })),
        el('button', {
          class: 'text-red-500 hover:bg-red-50 w-9 h-9 rounded-lg flex items-center justify-center',
          title: 'Delete key',
          onclick: async () => {
            if (!confirm(`Delete ${k.label}?`)) return
            await api('/api/admin/api-keys/' + k.id, { method: 'DELETE' })
            toast(k.label + ' deleted', 'success')
            renderApiKeys(container)
          }
        }, el('i', { class: 'fas fa-trash' }))))
    list.appendChild(row)
  })
  container.appendChild(list)
}

// Short text for the square badge: "Key A" → "A", "Main school key" → "MS"
function badgeText(label) {
  const l = String(label || '').trim()
  const m = l.match(/^key\s+([a-z0-9]{1,3})$/i)
  if (m) return m[1].toUpperCase()
  const words = l.split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase()
}

function fill(node, ...children) {
  children.flat().forEach((ch) => { if (ch != null) node.append(ch.nodeType ? ch : document.createTextNode(ch)) })
  return node
}

// Inline rename of a key label (pencil icon on the top right of every key card)
function startRename(k, titleRow, labelTitle, editBtn, container) {
  if (titleRow.querySelector('.api-key-rename-form')) return
  editBtn.classList.add('hidden')
  const input = el('input', {
    class: 'api-key-rename-input border border-indigo-300 rounded-lg px-2 py-1 text-sm font-semibold w-48 focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500',
    maxlength: '40', value: k.label, 'aria-label': 'New label'
  })
  const save = el('button', { type: 'button', title: 'Save', class: 'w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center' }, el('i', { class: 'fas fa-check text-sm' }))
  const cancel = el('button', { type: 'button', title: 'Cancel', class: 'w-8 h-8 rounded-lg border hover:bg-slate-50 text-slate-500 flex items-center justify-center' }, el('i', { class: 'fas fa-times text-sm' }))
  const form = el('div', { class: 'api-key-rename-form flex items-center gap-1.5' }, input, save, cancel)
  labelTitle.replaceWith(form)
  input.focus(); input.select()

  const close = () => { form.replaceWith(labelTitle); editBtn.classList.remove('hidden') }
  const submit = async () => {
    const label = input.value.replace(/\s+/g, ' ').trim()
    if (!label) return toast('The label cannot be empty', 'error')
    if (label === k.label) return close()
    save.disabled = true; save.innerHTML = '<span class="spinner"></span>'
    try {
      await api('/api/admin/api-keys/' + k.id, { method: 'PUT', body: JSON.stringify({ label }) })
      toast(`${k.label} renamed to ${label}`, 'success')
      renderApiKeys(container)
    } catch (e) {
      toast(e.message, 'error')
      save.disabled = false; save.innerHTML = '<i class="fas fa-check text-sm"></i>'
      input.focus()
    }
  }
  save.onclick = submit
  cancel.onclick = close
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
    if (e.key === 'Escape') { e.preventDefault(); close() }
  })
}

function statBox(icon, label, value, sub) {
  return el('div', { class: 'bg-white border rounded-2xl p-4' },
    el('p', { class: 'text-xs text-slate-500 flex items-center gap-1.5' }, el('i', { class: 'fas ' + icon + ' text-indigo-600' }), label),
    el('p', { class: 'text-lg font-bold mt-0.5' }, value),
    sub ? el('p', { class: 'text-xs font-mono text-slate-500 truncate' }, sub) : null)
}

function openAddKeyDialog() {
  const overlay = el('div', { class: 'fixed inset-0 z-50 bg-slate-900/70 flex items-center justify-center p-4' })
  const input = el('input', {
    id: 'new-api-key', placeholder: 'AIzaSy...', autocomplete: 'off', spellcheck: 'false',
    class: 'w-full border border-slate-300 rounded-lg px-3 py-2.5 font-mono text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100'
  })
  const msg = el('p', { class: 'text-sm mt-2 min-h-[1.25rem]' })
  const btn = el('button', { class: 'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg mt-3 disabled:opacity-60' }, 'Check & add key')
  btn.onclick = async () => {
    const key = input.value.trim()
    if (!key) return toast('Paste an API key first', 'error')
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span> Checking if the key works...'
    msg.textContent = ''
    try {
      const r = await api('/api/admin/api-keys', { method: 'POST', body: JSON.stringify({ api_key: key }) })
      toast(`Key works! Added as ${r.label}`, 'success')
      overlay.remove()
      boot()
    } catch (e) {
      msg.className = 'text-sm mt-2 text-red-600 break-words'
      msg.textContent = e.message
      btn.disabled = false
      btn.textContent = 'Check & add key'
    }
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click() })
  overlay.appendChild(el('div', { class: 'bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 relative fade-in' },
    el('button', { class: 'absolute top-3 right-3 text-slate-400 hover:text-slate-600 text-xl', onclick: () => overlay.remove() }, el('i', { class: 'fas fa-times' })),
    el('div', { class: 'w-12 h-12 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center mb-3' }, el('i', { class: 'fas fa-key text-xl' })),
    el('h2', { class: 'text-lg font-bold text-slate-800' }, 'Add Gemini API key'),
    el('p', { class: 'text-sm text-slate-500 mb-4' }, 'The website tests the key with Gemini first. If it works it is added to the rotation with the next label (Key A, Key B, Key C...).'),
    input, msg, btn))
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
  setTimeout(() => input.focus(), 50)
}

function userCard(u, container) {
  const inf = u.signup_info || {}
  const sw = inf.software || {}
  const net = inf.network || {}
  const dev = inf.device || {}
  const devIcon = sw.device_type === 'Mobile' ? 'fa-mobile-screen' : sw.device_type === 'Tablet' ? 'fa-tablet-screen-button' : 'fa-desktop'
  const photo = u.photo
    ? el('img', { src: u.photo, class: 'w-20 h-20 rounded-xl object-cover border' })
    : el('div', { class: 'w-20 h-20 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600' },
        el('i', { class: 'fas ' + (u.signup_info ? devIcon : 'fa-user') + ' text-2xl' }))

  const row = (label, val, mono) =>
    el('div', { class: 'flex justify-between gap-3 text-sm py-1 border-b border-slate-100 last:border-0' },
      el('span', { class: 'text-slate-400' }, label),
      el('span', { class: (mono ? 'font-mono ' : '') + 'text-slate-800 text-right break-all' }, val || '—'))

  return el('div', { class: 'bg-white rounded-2xl shadow-sm border p-5 fade-in' },
    el('div', { class: 'flex gap-4' },
      photo,
      el('div', { class: 'flex-1 min-w-0' },
        el('div', { class: 'flex items-center justify-between' },
          el('h3', { class: 'font-semibold truncate' }, u.username,
            el('span', { class: 'ml-2 text-[11px] font-medium ' + (u.is_online ? 'text-emerald-600' : 'text-slate-400') },
              el('i', { class: 'fas fa-circle text-[7px] mr-1 align-middle ' + (u.is_online ? 'text-emerald-500' : 'text-slate-300') }),
              u.is_online ? 'Online' : (u.last_seen ? 'Last online ' + new Date(String(u.last_seen).replace(' ', 'T') + 'Z').toLocaleString() : 'Never online'))),
          el('div', { class: 'flex items-center gap-1' },
            // Download backup button
            el('button', {
              class: 'text-indigo-500 hover:bg-indigo-50 w-8 h-8 rounded-lg flex items-center justify-center',
              title: 'Download backup',
              onclick: async () => {
                try {
                  const backup = await api('/api/admin/users/' + u.id + '/backup')
                  downloadJSON(backup, `unstudy_backup_${u.username}_${new Date().toISOString().split('T')[0]}.json`)
                  toast('Backup downloaded', 'success')
                } catch (e) { toast(e.message, 'error') }
              }
            }, el('i', { class: 'fas fa-download' })),
            // Delete button
            el('button', {
              class: 'text-red-500 hover:bg-red-50 w-8 h-8 rounded-lg flex items-center justify-center',
              title: 'Delete account',
              onclick: async () => {
                if (!confirm('Delete account "' + u.username + '" and all their data?')) return
                await api('/api/admin/users/' + u.id, { method: 'DELETE' })
                toast('Account deleted', 'success')
                boot()
              }
            }, el('i', { class: 'fas fa-trash' }))
          )
        ),
        el('p', { class: 'text-xs text-slate-400' }, u.photo ? 'Photo captured at verification (old account)' :
          (u.signup_info ? [sw.os, sw.browser].filter(Boolean).join(' · ') : 'No device info (created before v6)'))
      )
    ),
    el('div', { class: 'mt-4' },
      row('Email', u.email),
      row('Password', u.password, true),
      row('Full name', u.full_name),
      row('Birthday', u.birthday),
      row('Flashcard sets', String(u.flashcard_count)),
      row('Quizzes', String(u.quiz_count)),
      row('Created', new Date(u.created_at + 'Z').toLocaleString())
    ),
    signupInfoBlock(u, sw, net, dev)
  )
}

// Additional info captured when the account was created (admin only)
function signupInfoBlock(u, sw, net, dev) {
  if (!u.signup_info) return null
  const r = (label, val) => val ? el('div', { class: 'flex justify-between gap-3 text-xs py-1 border-b border-slate-100 last:border-0' },
    el('span', { class: 'text-slate-500 whitespace-nowrap' }, label),
    el('span', { class: 'text-slate-800 text-right break-all' }, String(val))) : null
  const loc = [net.city, net.region, net.country].filter(Boolean).join(', ')
  const coords = net.latitude && net.longitude ? `${net.latitude}, ${net.longitude}` : ''
  const section = (icon, title, ...rows) => {
    const items = rows.filter(Boolean)
    return el('div', { class: 'mb-2' },
      el('p', { class: 'text-[11px] font-bold uppercase tracking-wide text-indigo-600 mb-0.5 flex items-center gap-1.5' }, el('i', { class: 'fas ' + icon }), title),
      items.length ? items : el('p', { class: 'text-xs text-slate-500' }, 'Not detected'))
  }
  const details = el('details', { class: 'signup-info mt-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3' },
    el('summary', { class: 'cursor-pointer text-sm font-semibold text-slate-800 flex items-center gap-2' },
      el('i', { class: 'fas fa-circle-info text-indigo-600' }), 'Sign-up device & network info',
      el('span', { class: 'ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-900 text-white' }, 'Admin only')),
    el('div', { class: 'mt-2' },
      section('fa-laptop-code', 'Software',
        r('Operating system', [sw.os, sw.os_version].filter(Boolean).join(' ')),
        r('Browser / app', [sw.browser, sw.browser_version].filter(Boolean).join(' ')),
        r('Device', [sw.device_type, sw.device].filter(Boolean).join(' · ')),
        r('Screen', dev.screen),
        r('Language', dev.language),
        r('CPU cores / RAM', dev.cores ? `${dev.cores} cores${dev.memory_gb ? ' / ' + dev.memory_gb + ' GB' : ''}` : '')),
      section('fa-tower-cell', 'Carrier / ISP',
        r('ISP / carrier', net.isp),
        r('ASN', net.asn),
        r('Connection', [net.connection, net.effective_type].filter(Boolean).join(' · ')),
        r('IP address', u.signup_ip)),
      section('fa-location-dot', 'Location (internet based)',
        r('City / region / country', loc),
        r('Postal code', net.postal),
        r('Coordinates', coords),
        r('Timezone', net.timezone || dev.browser_timezone),
        net.maps_url ? el('a', { href: net.maps_url, target: '_blank', rel: 'noopener', class: 'inline-flex items-center gap-1 text-xs text-indigo-600 font-medium mt-1 hover:underline' },
          el('i', { class: 'fas fa-map' }), 'Open in Google Maps') : null),
      sw.user_agent ? el('p', { class: 'text-[10px] font-mono text-slate-500 break-all mt-1' }, sw.user_agent) : null))
  return details
}

// Download JSON as file
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 100)
}

// Restore / Upload dialog
function openRestoreDialog() {
  const overlay = el('div', {
    class: 'fixed inset-0 z-50 bg-slate-900/70 flex items-center justify-center p-4'
  })

  const fileInput = el('input', { type: 'file', accept: '.json', class: 'hidden' })
  const fileLabel = el('p', { class: 'text-sm text-slate-500 mt-3' }, 'No file selected')

  let fileData = null

  fileInput.onchange = async () => {
    const file = fileInput.files[0]
    if (!file) return
    try {
      const text = await file.text()
      fileData = JSON.parse(text)
      if (!(fileData._studymate_backup || fileData._unstudy_backup) || !fileData.user) {
        fileData = null
        fileLabel.textContent = 'Invalid backup file'
        fileLabel.className = 'text-sm text-red-500 mt-3'
        return
      }
      fileLabel.textContent = `Ready: ${fileData.user.username} (${fileData.user.email}) — ${(fileData.flashcards || []).length} flashcard sets, ${(fileData.quizzes || []).length} quizzes`
      fileLabel.className = 'text-sm text-emerald-600 mt-3'
    } catch (e) {
      fileData = null
      fileLabel.textContent = 'Could not read file'
      fileLabel.className = 'text-sm text-red-500 mt-3'
    }
  }

  const restoreBtn = el('button', {
    class: 'w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2.5 rounded-lg mt-4',
    onclick: async () => {
      if (!fileData) return toast('Select a valid backup file first', 'error')
      restoreBtn.disabled = true
      restoreBtn.innerHTML = '<span class="spinner"></span> Restoring...'
      try {
        const result = await api('/api/admin/users/restore', {
          method: 'POST',
          body: JSON.stringify(fileData)
        })
        toast(`Account "${result.username}" restored successfully!`, 'success')
        overlay.remove()
        boot()
      } catch (e) {
        toast(e.message, 'error')
        restoreBtn.disabled = false
        restoreBtn.textContent = 'Restore Account'
      }
    }
  }, 'Restore Account')

  const panel = el('div', { class: 'bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 relative fade-in' },
    el('button', {
      class: 'absolute top-3 right-3 text-slate-400 hover:text-slate-600 text-xl',
      onclick: () => overlay.remove()
    }, el('i', { class: 'fas fa-times' })),

    el('div', { class: 'text-center mb-4' },
      el('div', { class: 'w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3' },
        el('i', { class: 'fas fa-upload text-2xl' })
      ),
      el('h2', { class: 'text-lg font-bold text-slate-800' }, 'Restore Account from Backup'),
      el('p', { class: 'text-sm text-slate-500 mt-1' }, 'Upload an UNSTUDY (or StudyMate) backup JSON file to restore an account with all their flashcards and quizzes.')
    ),

    el('button', {
      class: 'w-full border-2 border-dashed border-slate-300 rounded-xl p-6 text-center hover:border-indigo-400 hover:bg-indigo-50/50 transition cursor-pointer',
      onclick: () => fileInput.click()
    },
      el('i', { class: 'fas fa-file-arrow-up text-2xl text-slate-400 mb-2' }),
      el('p', { class: 'text-sm text-slate-600 font-medium' }, 'Click to select backup file'),
      el('p', { class: 'text-xs text-slate-400 mt-1' }, 'Only .json backup files from UNSTUDY / StudyMate')
    ),
    fileInput,
    fileLabel,
    restoreBtn
  )

  overlay.appendChild(panel)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
}

boot()
