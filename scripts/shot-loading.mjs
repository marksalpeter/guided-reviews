import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, extname } from 'node:path'
const full = JSON.parse(await readFile('scripts/payload.json', 'utf8'))
// the state before the first guide lands: no chapters yet, generation still running
const payload = { ...full, guideBusy: true, review: { ...full.review, state: { ...full.review.state, guide: null } } }
const vars = '--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:ui-monospace,Menlo,Consolas,monospace;--vscode-editor-font-size:12.5px;--vscode-editorLineNumber-foreground:#6e7681;--vscode-editorLineNumber-activeForeground:#ccc;--vscode-diffEditor-insertedLineBackground:#1c3323;--vscode-diffEditor-removedLineBackground:#3a1d1d;--vscode-diffEditor-insertedTextBackground:#2b5b3a66;--vscode-diffEditor-removedTextBackground:#7a2c2c66;--vscode-panel-border:#2b2b2b;--vscode-descriptionForeground:#9d9d9d;--vscode-focusBorder:#0078d4;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#3c3c3c;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;--vscode-textLink-foreground:#4daafc;--vscode-editorWidget-background:#252526;--vscode-editorGroupHeader-tabsBackground:#181818;--vscode-editor-lineHighlightBackground:#2a2a2a;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#cca700;--vscode-gitDecoration-addedResourceForeground:#4ec983;--vscode-gitDecoration-deletedResourceForeground:#f14c4c;--vscode-checkbox-border:#3c3c3c'
const harness = `<!doctype html><html><head><meta charset="utf-8"/><link rel="stylesheet" href="./main.css"/><style>:root{${vars}}html,body{height:100%}</style></head><body class="vscode-dark"><div id="root"></div>
<script>const payload=${JSON.stringify(payload)};let s={};window.acquireVsCodeApi=()=>({postMessage:m=>{if(m.type==='ready')setTimeout(()=>window.postMessage({type:'review',payload},'*'),0)},setState:x=>{s=x},getState:()=>s})</script>
<script type="module" src="./main.js"></script></body></html>`
const types={'.js':'text/javascript','.css':'text/css','.map':'application/json'}
const server=createServer(async(req,res)=>{const url=(req.url??'/').split('?')[0]
 if(url.startsWith('/h')){res.writeHead(200,{'Content-Type':'text/html'});res.end(harness);return}
 try{const b=await readFile(join('dist/webview',url));res.writeHead(200,{'Content-Type':types[extname(url)]??'application/octet-stream'});res.end(b)}catch{res.writeHead(404);res.end()}})
await new Promise(r=>server.listen(4325,r))
const browser=await chromium.launch({args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2})
await page.goto('http://localhost:4325/h',{waitUntil:'networkidle'})
await page.waitForSelector('.gr-file')
await page.waitForTimeout(400)
await page.screenshot({ path: 'media/screenshot-loading.png' })
await browser.close(); server.close()
console.log('wrote media/screenshot-loading.png')
