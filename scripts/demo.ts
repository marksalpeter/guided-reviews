import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemExec } from '../src/core/exec.js'
import { Git } from '../src/core/git.js'
import { ClaudeCli } from '../src/core/guide.js'
import { ReviewService } from '../src/core/review.js'

/** serverTail is the half of the server this branch never touches, so its diff has a run to fold. */
const serverTail = [
  '/** notFound is the fallback for a path no route claims. */',
  'export function notFound(): Response {',
  '  return new Response("not found", { status: 404 })',
  '}',
  '',
  '/** health answers the load balancer without reading a session at all. */',
  'export function health(): Response {',
  '  return Response.json({ ok: true })',
  '}',
  '',
  '/** cors adds the headers a browser wants before it will read a reply. */',
  'export function cors(response: Response): Response {',
  '  response.headers.set("access-control-allow-origin", "*")',
  '  response.headers.set("access-control-allow-headers", "authorization")',
  '  return response',
  '}',
  '',
  '/** logged prints one line per request, which is all the logging this service has. */',
  'export function logged(req: Request, response: Response): Response {',
  '  console.log(req.method + " " + new URL(req.url).pathname + " " + response.status)',
  '  return response',
  '}',
  '',
  '/** port is where the service listens, unless the environment says otherwise. */',
  'export const port = Number(process.env.PORT ?? 8080)',
  '',
]

const files: Record<string, string> = {
  'src/auth.ts': [
    'import { createHash } from "node:crypto"',
    '',
    '/** Session is a verified caller. */',
    'export interface Session {',
    '  userId: string',
    '  expiresAt: number',
    '}',
    '',
    '/** verify parses and checks a signed session token. */',
    'export function verify(token: string | null, secret: string): Session | null {',
    '  if (!token) {',
    '    return null',
    '  }',
    '  const [payload, signature] = token.split(".")',
    '  if (!payload || !signature) {',
    '    return null',
    '  }',
    '  const expected = createHash("sha256").update(payload + secret).digest("hex")',
    '  if (expected !== signature) {',
    '    return null',
    '  }',
    '  const decoded = JSON.parse(Buffer.from(payload, "base64").toString())',
    '  return { userId: decoded.sub, expiresAt: decoded.exp }',
    '}',
    '',
  ].join('\n'),
  'src/server.ts': [
    'import { verify } from "./auth"',
    '',
    '/** handle routes one request, rejecting anything unauthenticated. */',
    'export function handle(req: Request, secret: string): Response {',
    '  const session = verify(req.headers.get("authorization"), secret)',
    '  if (!session) {',
    '    return new Response("unauthorized", { status: 401 })',
    '  }',
    '  if (session.expiresAt < Date.now()) {',
    '    return new Response("expired", { status: 401 })',
    '  }',
    '  return Response.json({ hello: session.userId })',
    '}',
    '',
    ...serverTail,
  ].join('\n'),
  'src/routes.ts': [
    'import { handle } from "./server"',
    '',
    '/** routes maps a path to its handler. */',
    'export const routes = {',
    '  "/api/me": handle,',
    '}',
    '',
  ].join('\n'),
  'package.json': '{\n  "name": "demo",\n  "version": "1.1.0",\n  "type": "module"\n}\n',
  'README.md': '# demo\n\nA tiny service.\n\n## Auth\n\nRequests carry a signed session token.\n',
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gr-demo-'))
  const exec = new SystemExec(dir)
  await exec.run('git', ['init', '-q', '-b', 'main'])
  await exec.run('git', ['config', 'user.email', 'demo@example.com'])
  await exec.run('git', ['config', 'user.name', 'Demo'])

  await mkdir(join(dir, 'src'), { recursive: true })
  const baseServer = ['export function handle(req: Request): Response {', '  return Response.json({ hello: "world" })', '}', '', ...serverTail]
  await writeFile(join(dir, 'src/server.ts'), baseServer.join('\n'))
  await writeFile(join(dir, 'package.json'), '{\n  "name": "demo",\n  "version": "1.0.0",\n  "type": "module"\n}\n')
  await writeFile(join(dir, 'README.md'), '# demo\n\nA tiny service.\n')
  await exec.run('git', ['add', '-A'])
  await exec.run('git', ['commit', '-qm', 'base'])

  await exec.run('git', ['checkout', '-qb', 'add-session-auth'])
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await exec.run('git', ['add', '-A'])
  await exec.run('git', ['commit', '-qm', 'add signed session auth'])

  await writeFile(join(dir, 'src/session.ts'), 'export const ttlSeconds = 3600\n')
  await exec.run('git', ['add', '-A'])
  await exec.run('git', ['commit', '-qm', 'pull the session ttl out into a constant'])

  const service = new ReviewService(new Git(dir, exec))
  const selection = await service.defaultSelection()
  const key = await service.openSelection(selection)

  await service.startThread(key, 'src/auth.ts', 'new', 21, 'JSON.parse on attacker-controlled input — wrap this in a try/catch, a malformed token should 401 not 500.')
  const second = await service.startThread(key, 'src/server.ts', 'new', 9, 'expiry check happens after verify() — fine, but should this be inside verify so every caller gets it?')
  await service.reply(key, second, 'Moved the expiry check into verify() in a follow-up commit — every caller now gets it for free.', 'agent')

  const settled = await service.startThread(key, 'src/routes.ts', 'new', 5, 'routes stores handle without the secret the new signature needs.')
  await service.reply(key, settled, 'Fixed — routes now closes over the secret from config.', 'agent')
  await service.resolveThread(key, settled)

  const readme = (await service.load(key)).files.find(f => f.path === 'README.md')
  if (readme?.newBlob) {
    await service.markReviewed(key, 'README.md', readme.newBlob)
  }

  process.stderr.write('generating guide with claude…\n')
  await service.generateGuide(key, new ClaudeCli('claude', 'claude-opus-5'))

  const { state, files: changed } = await service.load(key)
  const diff = await service.repo.unifiedDiff(state.refs.baseSha, state.refs.headSha)
  const selector = await service.selector(selection)

  process.stderr.write('\nGuide:\n')
  for (const group of state.guide?.groups ?? []) {
    process.stderr.write(`  ${group.title}\n    ${group.summary}\n    ${group.files.join(', ')}\n`)
  }

  // the shooters' harness answers loadSource out of this map, the way the panel answers it from git
  const sources: Record<string, string> = {}
  for (const file of changed.filter(file => file.oldBlob && !file.binary)) {
    sources[file.oldBlob ?? ''] = await service.repo.blobText(file.oldBlob ?? '')
  }

  const payload = { review: { state, files: changed, diff }, selector, guideBusy: false, sources }
  await writeFile('scripts/payload.json', JSON.stringify(payload, null, 2))
  process.stderr.write('\nwrote scripts/payload.json\n')
  await rm(dir, { recursive: true, force: true })
}

void main()
