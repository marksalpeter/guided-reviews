import { readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'

const root = process.cwd()
const webview = join(root, 'dist/webview')
const files = await walk(webview)
const entry = join(root, 'dist/review-entry.ts')

const imports = files.map((file, index) => {
  const spec = './webview/' + relative(webview, file).split('\\').join('/')
  return `import f${index} from ${JSON.stringify(spec)} with { type: 'file' }`
})
const entries = files.map((file, index) => {
  const name = relative(webview, file).split('\\').join('/')
  return `  ${JSON.stringify(name)}: f${index},`
})

await writeFile(
  entry,
  [
    `import { setPackedAssets } from '../src/cli/assets.ts'`,
    `import { binMain } from '../src/cli/bin.ts'`,
    ...imports,
    ``,
    `setPackedAssets({`,
    ...entries,
    `})`,
    ``,
    `void binMain(process.argv.slice(2)).then(code => {`,
    `  process.exit(code)`,
    `})`,
    ``,
  ].join('\n'),
)

const releaseTargets = [
  ['bun-linux-x64', 'review-linux-x64'],
  ['bun-linux-arm64', 'review-linux-arm64'],
  ['bun-darwin-x64', 'review-macos-x64'],
  ['bun-darwin-arm64', 'review-macos-arm64'],
  ['bun-windows-x64', 'review-windows-x64.exe'],
  ['bun-windows-arm64', 'review-windows-arm64.exe'],
]

const jobs = process.argv.includes('--all')
  ? releaseTargets.map(([target, name]) => ({ target, outfile: join(root, 'dist/binaries', name) }))
  : [{ outfile: join(root, 'dist/review') }]

await mkdir(join(root, 'dist/binaries'), { recursive: true })
for (const job of jobs) {
  const args = ['build', entry, '--compile', '--outfile', job.outfile]
  if (job.target) {
    args.push(`--target=${job.target}`)
  }
  await run(bunCommand(), args)
}

/** bunCommand is the local devDependency, unless BUN points somewhere else. */
function bunCommand() {
  if (process.env.BUN) return process.env.BUN
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('bun/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return join(pkgPath, '..', pkg.bin.bun)
  } catch (error) {
    throw new Error('bun is not installed. Run npm install in this repo.', { cause: error })
  }
}

/** walk lists every file under a directory. */
async function walk(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await walk(path)))
    } else {
      found.push(path)
    }
  }
  return found
}

/** run waits for a command to exit cleanly. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${code}`))
    })
  })
}
