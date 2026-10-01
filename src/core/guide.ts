import { spawn } from 'node:child_process'
import type { ChangedFile, GuideGroup } from './types.js'

/** otherChangesTitle names the group that holds files the model left unassigned. */
const otherChangesTitle = 'Other changes'

/** describeParallelism is how many one-sentence batches run at once. */
const describeParallelism = 8

/** describeSystemPrompt asks what each file's edit does, with no grouping to bias the answer. */
const describeSystemPrompt = [
  'You read a git diff and say what each changed file does.',
  'One sentence per file: what its edit does, and what that serves. Name the feature or behaviour it belongs to.',
  'Do not group the files, rank them, or judge the change.',
  'Reply with JSON only, matching: {"files":[{"path":string,"does":string}]}',
  'Cover every path given to you, once each, using only those paths.',
].join('\n')

/** groupSystemPrompt turns the per-file descriptions into chapters, never seeing the diff. */
const groupSystemPrompt = [
  'You are given one sentence per changed file, describing what it does. Group them into the chapters of a code review.',
  'A chapter is one thing the change does. Files that serve the same thing belong together however far apart they sit in the tree.',
  'Merge two chapters if you cannot explain one without the other.',
  'Reply with JSON only, matching: {"groups":[{"title":string,"summary":string,"files":string[]}]}',
  'title: a short noun phrase. summary: one or two sentences on what the chapter does and why those files are together.',
  'Put the main thing first and incidental edits last. Assign every path to exactly one chapter, using only the paths given to you.',
].join('\n')

/** GuideGenerator turns a diff into ordered, validated guide chapters. */
export class GuideGenerator {
  private runner: GuideRunner

  constructor(runner: GuideRunner) {
    this.runner = runner
  }

  /** generate describes each file, groups those descriptions, then repairs whatever came back. */
  async generate(files: readonly ChangedFile[], diff: string): Promise<GuideGroup[]> {
    // two passes: describing and grouping in one call makes the model partition by path, not by purpose
    const batches = describeBatches(files)
    const described = await Promise.all(
      batches.map(batch => this.runner.run(buildDescribePrompt(batch), diffForFiles(diff, batch.map(file => file.path)), describeSystemPrompt)),
    )
    const order = new Map(files.map((file, index) => [file.path, index]))
    // batches are packed by size; the grouping prompt still sees files in input order
    const notes = batches
      .flatMap((batch, index) => parseDescriptions(described[index] ?? '', batch.map(file => file.path)))
      .sort((a, b) => (order.get(a.path) ?? files.length) - (order.get(b.path) ?? files.length))
    if (notes.length === 0) {
      throw new Error('the guided review could not describe any changed file')
    }
    const raw = await this.runner.run(buildGroupPrompt(notes), '', groupSystemPrompt)
    const groups = parseGuideResponse(raw)
    if (groups === null) {
      throw new Error('the guided review response could not be parsed as JSON')
    }
    const repaired = repairGroups(groups, files.map(f => f.path))
    if (repaired.every(group => group.repaired)) {
      throw new Error('the guided review assigned no files to any chapter')
    }
    return repaired
  }
}

/** AgentCommand is a headless preset. Cursor has none, so it uses claude. */
export type AgentCommand = 'claude' | 'codex'

/** AgentOptions override the preset's binary and model. */
export interface AgentOptions {
  bin?: string
  model?: string
}

/** AgentRunner is one tool-free headless turn. `cmd` selects the preset's flags. */
export class AgentRunner {
  private cmd: AgentCommand
  private options: AgentOptions

  constructor(cmd: AgentCommand = 'claude', options: AgentOptions = {}) {
    this.cmd = cmd
    this.options = options
  }

  /** run sends one prompt and returns the process's raw stdout. */
  run(prompt: string, stdin: string, system: string): Promise<string> {
    const launch = agentPlan(this.cmd, this.options, prompt, system, stdin, process.env)
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env: launch.env })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('error', e => reject(new Error(`could not run ${launch.command}: ${e.message}`)))
      child.on('close', code => {
        if (code === 0) {
          resolve(out)
          return
        }
        reject(new Error(err.trim() || `${launch.command} exited with code ${code}`))
      })
      child.stdin.end(launch.input)
    })
  }
}

/** GuideRunner is the inference seam. Tests pass a fake; production passes AgentRunner. */
export type GuideRunner = Pick<AgentRunner, 'run'>

/** ClaudeCli is the Claude preset the extension constructs from its settings. */
export class ClaudeCli extends AgentRunner {
  constructor(command = 'claude', model = 'claude-opus-5') {
    super('claude', { bin: command, model })
  }
}

/** agentPlan is the argv and stdin for one preset. The diff stays on stdin so a long patch is not an argument. */
export function agentPlan(
  cmd: AgentCommand,
  options: AgentOptions,
  prompt: string,
  system: string,
  diff: string,
  parentEnv: NodeJS.ProcessEnv,
): AgentLaunch {
  const env = childEnv(parentEnv, cmd)
  if (cmd === 'codex') {
    return {
      command: options.bin || 'codex',
      // no prompt argument: `codex exec` reads the prompt from stdin when one is not given
      args: ['exec', '--skip-git-repo-check', '-s', 'read-only', ...(options.model ? ['--model', options.model] : [])],
      input: [system, prompt, diff].filter(part => part.length > 0).join('\n\n'),
      env,
    }
  }
  return {
    command: options.bin || 'claude',
    // no tools: grouping is pure inference, and it must not be able to touch the repo it reviews
    args: [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--model',
      options.model || 'claude-opus-5',
      '--allowed-tools',
      '',
      '--append-system-prompt',
      system,
    ],
    input: diff,
    env,
  }
}

/** childEnv drops the nested-session marker and, for Claude, allows the grouping pass to think. */
function childEnv(parent: NodeJS.ProcessEnv, cmd: AgentCommand): NodeJS.ProcessEnv {
  const env = { ...parent }
  // Claude Code refuses to start when this is already set, which it is when Claude itself launched us
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE
  if (cmd === 'claude') {
    env.MAX_THINKING_TOKENS = '8000'
  }
  return env
}

/** AgentLaunch is one ready-to-spawn headless process. */
export interface AgentLaunch {
  command: string
  args: string[]
  input: string
  env: NodeJS.ProcessEnv
}

/** describeBatches spreads files across min(count, 8) summarizers, balancing by changed lines so one large diff does not share a summarizer with a pile of small ones. */
export function describeBatches(files: readonly ChangedFile[]): ChangedFile[][] {
  const count = Math.min(files.length, describeParallelism)
  if (count === 0) {
    return []
  }
  // longest-processing-time-first: heaviest file first (input order breaks ties), then the lightest batch
  const ranked = files
    .map((file, index) => ({ file, index, weight: Math.max(1, file.additions + file.deletions) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  const loads = Array.from({ length: count }, () => 0)
  const groups: { file: ChangedFile; index: number }[][] = Array.from({ length: count }, () => [])
  for (const item of ranked) {
    let lightest = 0
    for (let batch = 1; batch < count; batch++) {
      if ((loads[batch] ?? 0) < (loads[lightest] ?? 0)) {
        lightest = batch
      }
    }
    loads[lightest] = (loads[lightest] ?? 0) + item.weight
    groups[lightest]?.push(item)
  }
  return groups.map(group => group.sort((a, b) => a.index - b.index).map(item => item.file))
}

/** diffForFiles is the patch slice for one batch. A diff with no file headers is returned whole. */
export function diffForFiles(diff: string, paths: readonly string[]): string {
  const sections = sectionsByPath(diff)
  if (sections.size === 0) {
    return diff
  }
  const sliced = paths.map(path => sections.get(path) ?? '').filter(part => part.length > 0).join('')
  return sliced.length > 0 ? sliced : diff
}

/** sectionsByPath splits a unified diff on `diff --git` headers, keyed by the new path. */
function sectionsByPath(diff: string): Map<string, string> {
  const sections = new Map<string, string>()
  if (!diff.includes('diff --git ')) {
    return sections
  }
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (!part.startsWith('diff --git ')) {
      continue
    }
    const newline = part.indexOf('\n')
    const path = newPath(newline === -1 ? part : part.slice(0, newline))
    if (path) {
      sections.set(path, (sections.get(path) ?? '') + part)
    }
  }
  return sections
}

/** newPath reads the b/ path from a `diff --git` header, including a quoted one. */
function newPath(header: string): string {
  const quoted = header.match(/^diff --git "a\/.*" "b\/(.*)"$/)
  if (quoted?.[1]) {
    return quoted[1].replace(/\\"/g, '"')
  }
  const plain = header.match(/^diff --git a\/.* b\/(.*)$/)
  return plain?.[1] ?? ''
}

/** buildDescribePrompt states the exact set of paths the model must describe. */
export function buildDescribePrompt(files: readonly ChangedFile[]): string {
  const manifest = files
    .map(f => `- ${f.path} (+${f.additions}/-${f.deletions}${f.binary ? ', binary' : ''}, ${f.status})`)
    .join('\n')
  return ['Describe each file changed by the unified diff on stdin.', '', 'Changed files:', manifest, '', 'Reply with JSON only.'].join('\n')
}

/** buildGroupPrompt hands the grouping pass the descriptions and nothing else. */
export function buildGroupPrompt(notes: readonly FileNote[]): string {
  const described = notes.map(note => `- ${note.path}: ${note.does}`).join('\n')
  return ['Group these changed files into the chapters of a code review.', '', described, '', 'Reply with JSON only.'].join('\n')
}

/** parseDescriptions reads the first pass back, keeping one note per real path. */
export function parseDescriptions(raw: string, changedPaths: readonly string[]): FileNote[] {
  const payload = extractJsonObject(unwrapEnvelope(raw))
  const described = (payload as { files?: unknown } | null)?.files
  const notes = new Map<string, string>()
  for (const entry of Array.isArray(described) ? (described as RawNote[]) : []) {
    const path = String(entry?.path ?? '')
    if (changedPaths.includes(path) && !notes.has(path)) {
      notes.set(path, String(entry?.does ?? ''))
    }
  }
  // a file the first pass skipped still has to reach the grouping pass, so fall back to its path
  return changedPaths.map(path => ({ path, does: notes.get(path) ?? 'no description' }))
}

/** parseGuideResponse digs the groups array out of Claude Code's json envelope. */
export function parseGuideResponse(raw: string): RawGroup[] | null {
  const text = unwrapEnvelope(raw)
  const payload = extractJsonObject(text)
  if (payload === null) {
    return null
  }
  const groups = (payload as { groups?: unknown }).groups
  return Array.isArray(groups) ? (groups as RawGroup[]) : null
}

/** repairGroups enforces the one-file-one-group invariant, visibly rather than silently. */
export function repairGroups(groups: readonly RawGroup[], changedPaths: readonly string[]): GuideGroup[] {
  const valid = new Set(changedPaths)
  const claimed = new Set<string>()

  const repaired = groups
    .map((group, index) => toGuideGroup(group, index, valid, claimed))
    .filter(group => group.files.length > 0)

  const unassigned = changedPaths.filter(path => !claimed.has(path))
  if (unassigned.length > 0) {
    repaired.push({
      id: `g${repaired.length}-other`,
      title: otherChangesTitle,
      summary: 'Files the guide did not classify.',
      files: unassigned,
      repaired: true,
    })
  }
  return repaired
}

/** toGuideGroup normalises one model-supplied group, claiming each file for its first group. */
function toGuideGroup(group: RawGroup, index: number, valid: Set<string>, claimed: Set<string>): GuideGroup {
  const files: string[] = []
  for (const path of Array.isArray(group.files) ? group.files : []) {
    if (valid.has(path) && !claimed.has(path)) {
      claimed.add(path)
      files.push(path)
    }
  }
  return {
    id: `g${index}-${slug(String(group.title ?? 'group'))}`,
    title: String(group.title ?? 'Untitled'),
    summary: String(group.summary ?? ''),
    files,
  }
}

/** unwrapEnvelope returns the assistant text from a Claude Code json result, or the input as-is. */
function unwrapEnvelope(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    const result = (parsed as { result?: unknown }).result
    return typeof result === 'string' ? result : raw
  } catch {
    return raw
  }
}

/** extractJsonObject picks the grouping out of a reply that reasons in prose before its JSON. */
function extractJsonObject(text: string): unknown {
  let fallback: unknown = null
  let withGroups: unknown = null
  for (const candidate of balancedObjects(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    // the reasoning can quote the schema, so the answer is the last object that actually carries groups
    if (Array.isArray((parsed as { groups?: unknown }).groups)) {
      withGroups = parsed
    }
    fallback ??= parsed
  }
  return withGroups ?? fallback
}

/** balancedObjects yields each top-level {...} span in text, skipping braces inside strings. */
function* balancedObjects(text: string): Generator<string> {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' && depth > 0) {
      inString = !inString
      continue
    }
    if (inString) {
      continue
    }
    if (char === '{') {
      if (depth === 0) {
        start = i
      }
      depth++
    } else if (char === '}' && depth > 0) {
      depth--
      if (depth === 0) {
        yield text.slice(start, i + 1)
      }
    }
  }
}

/** slug reduces a title to an id-safe fragment. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'group'
}

/** FileNote is one file's description, the only thing the grouping pass sees. */
export interface FileNote {
  path: string
  does: string
}

/** RawNote is one unvalidated description from the first pass. */
interface RawNote {
  path?: unknown
  does?: unknown
}

/** RawGroup is one unvalidated group as the model returned it. */
export interface RawGroup {
  title?: unknown
  summary?: unknown
  files?: unknown
}

export const __test = { extractJsonObject, unwrapEnvelope, slug, describeSystemPrompt, groupSystemPrompt }
