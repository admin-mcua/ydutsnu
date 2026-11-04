// SEO helpers: robots.txt, sitemap.xml, meta tags, JSON-LD structured data.

export const SEO_TITLE = 'Unstudy – AI Flashcards & Quiz Maker | Review Lessons the Smart Way'
export const SEO_DESC =
  'Unstudy is a free AI study app: upload notes or PDFs and instantly get flashcards and quizzes, join live quiz rooms with a code, study with classmates and review lessons the smart way.'
export const SEO_KEYWORDS =
  'Unstudy, unstudy app, unstudy.com, AI flashcards, flashcard maker, AI quiz maker, quiz generator, study app, PDF to flashcards, review lessons, live quiz room, study with classmates'

export function robotsTxt(site: string) {
  return `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Disallow: /auth/

Sitemap: ${site}/sitemap.xml
`
}

export function sitemapXml(site: string) {
  const today = new Date().toISOString().slice(0, 10)
  const urls = [
    { loc: '/', pri: '1.0', freq: 'daily' },
    { loc: '/login', pri: '0.6', freq: 'monthly' },
    { loc: '/login?mode=signup', pri: '0.6', freq: 'monthly' }
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${site}${u.loc.replace(/&/g, '&amp;')}</loc><lastmod>${today}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`
}

export type SeoOpts = { kind?: string; site?: string; path?: string; googleVerify?: string; bingVerify?: string }

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export function seoHead(o: SeoOpts = {}) {
  const site = (o.site || '').replace(/\/+$/, '')
  const kind = o.kind || 'home'
  const titles: Record<string, string> = {
    home: SEO_TITLE,
    app: SEO_TITLE,
    login: 'Log in or Sign up | Unstudy',
    admin: 'Admin | Unstudy',
    share: 'Flashcards | Unstudy',
    quiz: 'Quiz | Unstudy',
    game: 'Live Quiz Room | Unstudy'
  }
  const title = titles[kind] || SEO_TITLE
  // Only the home page and login page should be indexed; the rest are app / private pages
  const indexable = kind === 'home' || kind === 'login'
  const canonical = site + (kind === 'home' || kind === 'app' ? '/' : (o.path || '/'))
  const image = site + '/static/logo-512.png'

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Unstudy',
      alternateName: ['UNSTUDY', 'Unstudy App', 'Unstudy AI'],
      url: site + '/',
      description: SEO_DESC,
      inLanguage: 'en'
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Unstudy',
      url: site + '/',
      logo: image
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Unstudy',
      url: site + '/',
      applicationCategory: 'EducationalApplication',
      operatingSystem: 'Any (web browser)',
      description: SEO_DESC,
      image,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'AI flashcard generator from notes and PDFs',
        'AI quiz maker (multiple choice, true/false, identification, situational)',
        'Live quiz rooms you can join with a code',
        'Classes and study with friends'
      ]
    }
  ]

  return `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(SEO_DESC)}">
    <meta name="keywords" content="${esc(SEO_KEYWORDS)}">
    <meta name="author" content="Unstudy">
    <meta name="robots" content="${indexable ? 'index, follow, max-image-preview:large, max-snippet:-1' : 'noindex, nofollow'}">
    ${site ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Unstudy">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(SEO_DESC)}">
    ${site ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
    <meta property="og:image" content="${esc(image)}">
    <meta property="og:image:width" content="512">
    <meta property="og:image:height" content="512">
    <meta property="og:locale" content="en_US">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(SEO_DESC)}">
    <meta name="twitter:image" content="${esc(image)}">
    ${o.googleVerify ? `<meta name="google-site-verification" content="${esc(o.googleVerify)}">` : ''}
    ${o.bingVerify ? `<meta name="msvalidate.01" content="${esc(o.bingVerify)}">` : ''}
    ${kind === 'home' || kind === 'app' ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
  `
}

// Crawlable text for search engines (and users without JavaScript).
// The JS app replaces #root, so this is visible only until the app loads.
export function seoBody(kind = 'home') {
  if (kind !== 'home' && kind !== 'app' && kind !== 'login') return ''
  return `
  <noscript>
    <main style="max-width:720px;margin:40px auto;padding:0 16px;font-family:system-ui,sans-serif;color:#1e293b">
      <h1>Unstudy – AI Flashcards &amp; Quiz Maker</h1>
      <p>Unstudy helps students review lessons the smart way. Upload your notes or a PDF and Unstudy's AI instantly creates flashcards and quizzes for you.</p>
      <h2>What you can do on Unstudy</h2>
      <ul>
        <li>Generate AI flashcards from notes and PDFs</li>
        <li>Create quizzes: multiple choice, true or false, identification and situational</li>
        <li>Join a live quiz room with a code, no account needed</li>
        <li>Host quiz rooms with a schedule and a leaderboard</li>
        <li>Study together in classes and share flashcards with friends</li>
      </ul>
      <p><a href="/login">Log in</a> or <a href="/login?mode=signup">create a free Unstudy account</a>. Please enable JavaScript to use Unstudy.</p>
    </main>
  </noscript>`
}
