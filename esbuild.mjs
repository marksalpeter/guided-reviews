import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
}

const targets = [
  { ...shared, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...shared, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', external: [], banner: { js: '#!/usr/bin/env node' } },
  { ...shared, entryPoints: ['src/cli/bin.ts'], outfile: 'dist/review.js', external: [], banner: { js: '#!/usr/bin/env node' } },
]

if (watch) {
  for (const t of targets) (await context(t)).watch()
} else {
  await Promise.all(targets.map(build))
}
