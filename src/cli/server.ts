import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { GuideRunner } from '../core/guide.js'
import type { HostMessage, ViewMessage } from '../core/protocol.js'
import type { ReviewService } from '../core/review.js'
import { readPacked } from './assets.js'
import { ReviewHost, type SubmitResult } from './host.js'

/** startReviewServer serves the webview and blocks the caller on Submit via `submitted`. */
export async function startReviewServer(options: ServerOptions): Promise<RunningReview> {
  const host = new ReviewHost(options.service, options.runner, options.focusThread ?? '')
  const clients = new Set<ServerResponse>()
  host.send = (message: HostMessage) => {
    const chunk = `data: ${JSON.stringify(message)}\n\n`
    for (const client of clients) {
      client.write(chunk)
    }
  }

  const server = createServer((req, res) => {
    void route(req, res, host, clients, options.assetsDir).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
      }
      res.end()
    })
  })

  await new Promise<void>(resolve => {
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  await host.start()

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    submitted: host.submitted,
    close: () => closeServer(server, clients, host),
  }
}

/** route dispatches one request to the event stream, the page, or a static asset. */
async function route(
  req: IncomingMessage,
  res: ServerResponse,
  host: ReviewHost,
  clients: Set<ServerResponse>,
  assetsDir: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/message') {
    const message = JSON.parse(await readBody(req)) as ViewMessage
    await host.handle(message)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
  const file = (await readPacked(name)) ?? (await readAsset(assetsDir, name))
  if (!file) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': contentType(name) })
  res.end(req.method === 'HEAD' ? undefined : file)
}

/** readAsset reads one file from the webview build, refusing to leave that directory. */
async function readAsset(root: string, name: string): Promise<Buffer | undefined> {
  const relative = normalize(name).replace(/^(\.\.(\/|\\|$))+/, '')
  const path = join(root, relative)
  if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return undefined
  }
  try {
    return await readFile(path)
  } catch {
    return undefined
  }
}

/** readBody collects a request body. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** closeServer stops listening and drops the log watcher. */
function closeServer(server: Server, clients: Set<ServerResponse>, host: ReviewHost): Promise<void> {
  host.close()
  for (const client of clients) {
    client.end()
  }
  return new Promise(resolve => server.close(() => resolve()))
}

/** contentType is the handful of types the built webview ships. */
function contentType(name: string): string {
  switch (extname(name)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.json':
      return 'application/json'
    case '.map':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
}

/** ServerOptions are the repo, the guide runner, and where the built page lives. */
export interface ServerOptions {
  service: ReviewService
  runner: GuideRunner
  assetsDir: string
  port?: number
  focusThread?: string
}

/** RunningReview is a listening server and the promise that resolves on Submit. */
export interface RunningReview {
  url: string
  port: number
  submitted: Promise<SubmitResult>
  close(): Promise<void>
}
