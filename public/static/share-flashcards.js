import { api, el, toast, brandMark } from './common.js'

const root = document.getElementById('root')
const slug = location.pathname.split('/').pop()

function header(title) {
  return el('header', { class: 'bg-white border-b' },
    el('div', { class: 'max-w-3xl mx-auto px-4 py-3 flex items-center gap-2 text-indigo-600 font-bold' },
      el('a', { href: '/' }, brandMark(28)),
      el('span', { class: 'text-slate-400 font-normal text-sm ml-2 truncate' }, '· ' + title)
    ))
}

async function boot() {
  root.innerHTML = '<div class="text-center py-20 text-slate-400"><span class="spinner spinner-dark"></span> Loading flashcards...</div>'
  try {
    const data = await api('/api/share/flashcards/' + slug)
    root.innerHTML = ''
    root.appendChild(header(data.title))
    const main = el('main', { class: 'max-w-3xl mx-auto px-4 py-6' })
    main.appendChild(el('h1', { class: 'text-xl font-bold mb-1' }, data.title))
    main.appendChild(el('p', { class: 'text-sm text-slate-500 mb-5' }, `${data.cards.length} flashcards · tap a card to flip`))

    const grid = el('div', { class: 'grid sm:grid-cols-2 gap-3' })
    data.cards.forEach((c, i) => {
      const inner = el('div', { class: 'card-inner w-full h-40' },
        el('div', { class: 'card-face card-front bg-indigo-50 border border-indigo-100 font-medium' }, c.front),
        el('div', { class: 'card-face card-back bg-indigo-600 text-white' }, c.back)
      )
      grid.appendChild(el('div', { class: 'card-flip cursor-pointer', onclick: () => inner.classList.toggle('flipped') },
        inner, el('div', { class: 'text-xs text-slate-400 mt-1 text-center' }, `Card ${i + 1}`)))
    })
    main.appendChild(grid)
    root.appendChild(main)
  } catch (e) {
    root.innerHTML = '<div class="text-center py-20 text-slate-500"><i class="fas fa-triangle-exclamation text-3xl mb-2 text-amber-400"></i><p>This flashcard set could not be found.</p></div>'
  }
}
boot()
