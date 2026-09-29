// Returns the HTML shell for each page. Frontend logic lives in /static/*.js
export function pageShell(page: string): string {
  const head = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>UNSTUDY — Review Smarter</title>
    <link rel="icon" type="image/svg+xml" href="/static/logo.svg">
    <link rel="apple-touch-icon" href="/static/logo.svg">
    <meta name="theme-color" content="#6366f1">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      // IMPORTANT: dark mode is controlled ONLY by the app's theme toggle
      // (the "dark" class on <html>), never by the phone/OS dark setting.
      tailwind.config = { darkMode: 'class' }
    </script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <link href="/static/style.css" rel="stylesheet">
    <script>
      // Apply saved theme immediately to prevent flash
      (function(){
        var t = localStorage.getItem('theme') || 'light';
        if(t==='dark') document.documentElement.classList.add('dark');
      })();
    </script>
  `

  const scripts: Record<string, string> = {
    auth: `
      <script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script>
      <script type="module" src="/static/auth.js"></script>
    `,
    app: `
      <script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script>
      <script type="module" src="/static/app.js"></script>
    `,
    admin: `<script type="module" src="/static/admin.js"></script>`,
    'share-flashcards': `<script type="module" src="/static/share-flashcards.js"></script>`,
    quiz: `<script type="module" src="/static/quiz.js"></script>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>${head}</head>
<body class="bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 min-h-screen transition-colors">
  <div id="root"></div>
  ${scripts[page] || ''}
</body>
</html>`
}
