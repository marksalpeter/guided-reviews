import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, extname } from 'node:path'

const payload = JSON.parse(await readFile('scripts/payload.json', 'utf8'))

// VS Code hands webviews the whole theme as CSS variables; these are Dark+ / Light+ values.
const themes = {
  dark: {
    'editor-background': '#1f1f1f', 'editor-foreground': '#cccccc', 'foreground': '#cccccc',
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', 'font-size': '13px',
    'editor-font-family': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', 'editor-font-size': '12.5px',
    'editorLineNumber-foreground': '#6e7681', 'editorLineNumber-activeForeground': '#cccccc',
    'diffEditor-insertedLineBackground': '#1c3323', 'diffEditor-removedLineBackground': '#3a1d1d',
    'diffEditor-insertedTextBackground': '#2b5b3a66', 'diffEditor-removedTextBackground': '#7a2c2c66',
    'panel-border': '#2b2b2b', 'descriptionForeground': '#9d9d9d', 'focusBorder': '#0078d4',
    'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
    'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc',
    'textLink-foreground': '#4daafc', 'editorWidget-background': '#252526',
    'editorGroupHeader-tabsBackground': '#181818', 'editor-lineHighlightBackground': '#2a2a2a',
    'errorForeground': '#f85149', 'editorWarning-foreground': '#cca700',
    'gitDecoration-addedResourceForeground': '#4ec983', 'gitDecoration-deletedResourceForeground': '#f14c4c',
    'charts-orange': '#d18616', 'charts-purple': '#b180d7',
    'list-hoverBackground': '#2a2d2e', 'list-activeSelectionBackground': '#04395e',
    'list-activeSelectionForeground': '#ffffff', 'toolbar-hoverBackground': '#5a5d5e50',
    'checkbox-border': '#3c3c3c',
  },
  light: {
    'editor-background': '#ffffff', 'editor-foreground': '#3b3b3b', 'foreground': '#3b3b3b',
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', 'font-size': '13px',
    'editor-font-family': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', 'editor-font-size': '12.5px',
    'editorLineNumber-foreground': '#6e7681', 'editorLineNumber-activeForeground': '#171184',
    'diffEditor-insertedLineBackground': '#dafbe1', 'diffEditor-removedLineBackground': '#ffebe9',
    'diffEditor-insertedTextBackground': '#aceebb88', 'diffEditor-removedTextBackground': '#ffcecb88',
    'panel-border': '#e5e5e5', 'descriptionForeground': '#616161', 'focusBorder': '#005fb8',
    'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece',
    'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8',
    'button-secondaryBackground': '#f3f3f3', 'button-secondaryForeground': '#3b3b3b',
    'textLink-foreground': '#005fb8', 'editorWidget-background': '#f8f8f8',
    'editorGroupHeader-tabsBackground': '#f8f8f8', 'editor-lineHighlightBackground': '#f0f0f0',
    'errorForeground': '#f85149', 'editorWarning-foreground': '#bf8803',
    'gitDecoration-addedResourceForeground': '#1a7f37', 'gitDecoration-deletedResourceForeground': '#cf222e',
    'charts-orange': '#d18616', 'charts-purple': '#652d90',
    'list-hoverBackground': '#e8e8e8', 'list-activeSelectionBackground': '#0060c0',
    'list-activeSelectionForeground': '#ffffff', 'toolbar-hoverBackground': '#b8b8b850',
    'checkbox-border': '#cecece',
  },
}

const harness = (theme) => `<!doctype html>
<html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="./main.css"/>
<style>:root{${Object.entries(themes[theme]).map(([k, v]) => `--vscode-${k}:${v}`).join(';')}}
html,body{height:100%}</style>
</head>
<body class="vscode-${theme}">
<div id="root"></div>
<script>
  const payload = ${JSON.stringify(payload)};
  let saved = {};
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => { if (m.type === 'ready') setTimeout(() => window.postMessage({type:'review', payload}, '*'), 0) },
    setState: (s) => { saved = s }, getState: () => saved,
  });
</script>
<script type="module" src="./main.js"></script>
</body></html>`

const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.map': 'application/json' }
const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (url.startsWith('/harness-')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(harness(url.includes('light') ? 'light' : 'dark'))
    return
  }
  try {
    const body = await readFile(join('dist/webview', url))
    res.writeHead(200, { 'Content-Type': types[extname(url)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end()
  }
})
await new Promise(r => server.listen(4319, r))

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const errors = []
for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
  page.on('pageerror', e => errors.push(`${theme}: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`${theme} console: ${m.text()}`) })
  await page.goto(`http://localhost:4319/harness-${theme}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.gr-file', { timeout: 20000 })
  await page.waitForTimeout(700)
  await page.screenshot({ path: `media/screenshot-${theme}.png` })
  if (theme === 'dark') {
    const stats = await page.evaluate(() => ({
      files: document.querySelectorAll('.gr-file').length,
      groups: document.querySelectorAll('.gr-chapter').length,
      threads: document.querySelectorAll('.gr-thread').length,
      styledTokens: document.querySelectorAll('.diff-code span[style*="color"]').length,
      insertRows: document.querySelectorAll('.diff-code-insert').length,
      firstGroup: document.querySelector('.gr-group-title')?.textContent,
      reviewedFiles: document.querySelectorAll('.gr-file.reviewed').length,
      resolvedThreads: document.querySelectorAll('.gr-thread.resolved').length,
      composers: document.querySelectorAll('.gr-composer').length,
      firstFile: document.querySelector('.gr-file-header strong')?.textContent,
    }))
    await writeFile('scripts/render-stats.json', JSON.stringify(stats, null, 2))
    console.log(JSON.stringify(stats, null, 2))
  }
  await page.close()
}
await browser.close()
server.close()
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors')
