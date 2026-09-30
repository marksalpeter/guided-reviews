import { readdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
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

await run(process.env.BUN ?? 'bun', ['build', entry, '--compile', '--outfile', join(root, 'dist/review')])

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
