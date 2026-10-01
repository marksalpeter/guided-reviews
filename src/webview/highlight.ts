import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { ThemeRegistration } from 'shiki'
import darkPlus from 'shiki/themes/dark-plus.mjs'
import lightPlus from 'shiki/themes/light-plus.mjs'
import vscode2026Dark from './themes/vscode-2026-dark.json'
import vscode2026Light from './themes/vscode-2026-light.json'
import { aliasExtensions, grammarLoaders } from './grammars.js'

/** extensionOverrides covers extensions shiki's own aliases do not, and wins over them. */
const extensionOverrides: Record<string, string> = {
  bash: 'shellscript', sh: 'shellscript', zsh: 'shellscript', fish: 'shellscript',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  clj: 'clojure', cljs: 'clojure', edn: 'clojure',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  dart: 'dart',
  diff: 'diff', patch: 'diff',
  ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hrl: 'erlang',
  go: 'go',
  graphql: 'graphql', gql: 'graphql',
  gradle: 'groovy', groovy: 'groovy',
  hs: 'haskell',
  hcl: 'hcl', tf: 'hcl', tfvars: 'hcl',
  htm: 'html', html: 'html',
  cfg: 'ini', conf: 'ini', ini: 'ini', properties: 'ini',
  java: 'java',
  cjs: 'javascript', js: 'javascript', mjs: 'javascript',
  json: 'json', json5: 'json', jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin', kts: 'kotlin',
  lua: 'lua',
  markdown: 'markdown', md: 'markdown', mdx: 'markdown',
  m: 'objective-c', mm: 'objective-c',
  pl: 'perl', pm: 'perl',
  php: 'php',
  ps1: 'powershell', psm1: 'powershell',
  proto: 'proto',
  py: 'python', pyi: 'python',
  r: 'r',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  rs: 'rust',
  sc: 'scala', scala: 'scala',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  toml: 'toml',
  cts: 'typescript', mts: 'typescript', ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  svg: 'xml', xml: 'xml', xsd: 'xml',
  yaml: 'yaml', yml: 'yaml',
  zig: 'zig',
}

/** filenameLanguages maps whole filenames that carry no useful extension. */
const filenameLanguages: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'nginx.conf': 'nginx',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
}

/** plaintext is the language used when nothing else fits; it is never highlighted. */
export const plaintext = 'plaintext'

/** loadRefractor loads only the grammars these paths need, then returns a synchronous shim. */
export async function loadRefractor(paths: readonly string[], theme: ThemeName): Promise<RefractorLike> {
  const languages = [...new Set(paths.map(languageForPath))].filter(language => language !== plaintext)
  const highlighter = await ensureLanguages(languages)
  return {
    highlight(value: string, language: string): HastNode[] {
      if (!highlighter.getLoadedLanguages().includes(language)) {
        return [{ type: 'text', value }]
      }
      return flattenLines(highlighter.codeToHast(value, { lang: language, theme }) as HastNode)
    },
  }
}

/** languageForPath picks a grammar for a path, or plaintext when none fits. */
export function languageForPath(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const byName = filenameLanguages[name]
  if (byName) {
    return resolveGrammar(byName)
  }
  const extension = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  return resolveGrammar(extensionOverrides[extension] ?? aliasExtensions[extension])
}

/** resolveGrammar turns a grammar id or one of shiki's aliases into a loadable id. */
function resolveGrammar(name: string | undefined): string {
  if (!name) {
    return plaintext
  }
  if (grammarLoaders[name]) {
    return name
  }
  const aliased = aliasExtensions[name]
  return aliased && grammarLoaders[aliased] ? aliased : plaintext
}

/** activeTheme reads the theme VS Code stamped on the document body, or the 2026 default outside it. */
export function activeTheme(): ThemeName {
  const body = document.body.classList
  if (body.contains('vscode-light') || body.contains('vscode-high-contrast-light')) {
    return 'light-plus'
  }
  if ([...body].some(name => name.startsWith('vscode-'))) {
    return 'dark-plus'
  }
  if (body.contains('gr-light')) {
    return '2026 Light'
  }
  if (body.contains('gr-dark')) {
    return '2026 Dark'
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? '2026 Light' : '2026 Dark'
}

/** ensureLanguages loads any grammars the highlighter does not already hold. */
async function ensureLanguages(languages: readonly string[]): Promise<HighlighterCore> {
  const highlighter = await getHighlighter()
  const loaded = new Set(highlighter.getLoadedLanguages())
  const missing = languages.filter(language => !loaded.has(language) && grammarLoaders[language])
  if (missing.length > 0) {
    const grammars = await Promise.all(missing.map(language => grammarLoaders[language]!()))
    await highlighter.loadLanguage(...grammars.map(grammar => grammar.default))
  }
  return highlighter
}

/** getHighlighter builds the shared highlighter once, with themes but no grammars. */
function getHighlighter(): Promise<HighlighterCore> {
  cached ??= createHighlighterCore({
    themes: [darkPlus, lightPlus, vscode2026Dark as ThemeRegistration, vscode2026Light as ThemeRegistration],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  return cached
}

/** cached holds the single highlighter instance for the life of the webview. */
let cached: Promise<HighlighterCore> | undefined

/** flattenLines unwraps Shiki's pre > code > span.line tree into refractor's flat node list. */
function flattenLines(root: HastNode): HastNode[] {
  const code = findElement(findElement(root, 'pre'), 'code')
  if (!code?.children) {
    return []
  }
  const flat: HastNode[] = []
  const lines = code.children.filter(child => child.type === 'element')
  lines.forEach((line, index) => {
    if (index > 0) {
      flat.push({ type: 'text', value: '\n' })
    }
    flat.push(...(line.children ?? []))
  })
  return flat
}

/** findElement returns the first child element with the given tag name. */
function findElement(node: HastNode | undefined, tagName: string): HastNode | undefined {
  return node?.children?.find(child => child.type === 'element' && child.tagName === tagName)
}

/** ThemeName is a VS Code default theme. Plus themes follow the editor; 2026 themes are the browser default. */
export type ThemeName = 'dark-plus' | 'light-plus' | '2026 Dark' | '2026 Light'

/** RefractorLike is the narrow surface react-diff-view calls for syntax highlighting. */
export interface RefractorLike {
  highlight(value: string, language: string): HastNode[]
}

/** HastNode is one node of the syntax tree, carrying Shiki's inline style properties. */
export interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { style?: string; className?: string | string[] }
  children?: HastNode[]
}

export const __test = { grammarLoaders, extensionOverrides, filenameLanguages, aliasExtensions }
