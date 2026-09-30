import { describe, expect, it } from 'vitest'
import { agentPlan } from './guide.js'
import { detectAgentCommand } from './harness.js'

describe('detectAgentCommand', () => {
  it('uses claude unless Codex marked the process', () => {
    expect(detectAgentCommand({})).toBe('claude')
    expect(detectAgentCommand({ CLAUDECODE: '1' })).toBe('claude')
    expect(detectAgentCommand({ CURSOR_AGENT: '1' })).toBe('claude')
    expect(detectAgentCommand({ CODEX_THREAD_ID: 'thread_1' })).toBe('codex')
    expect(detectAgentCommand({ CODEX_SANDBOX: '1' })).toBe('codex')
  })
})

describe('agentPlan', () => {
  it('builds a tool-free claude turn and drops the nested-session marker', () => {
    const launch = agentPlan('claude', {}, 'describe', 'system', 'diff', { CLAUDECODE: '1', PATH: '/bin' })
    expect(launch.command).toBe('claude')
    expect(launch.args).toContain('-p')
    expect(launch.args).toContain('--allowed-tools')
    expect(launch.args).toContain('--max-turns')
    expect(launch.input).toBe('diff')
    expect(launch.env.CLAUDECODE).toBeUndefined()
    expect(launch.env.MAX_THINKING_TOKENS).toBe('8000')
    expect(launch.env.PATH).toBe('/bin')
  })

  it('honours a claude path and model override', () => {
    const launch = agentPlan('claude', { bin: '/opt/claude', model: 'claude-sonnet-4' }, 'p', 's', '', {})
    expect(launch.command).toBe('/opt/claude')
    expect(launch.args).toContain('claude-sonnet-4')
  })

  it('builds a read-only codex exec whose prompt includes the diff', () => {
    const launch = agentPlan('codex', { model: 'gpt-5' }, 'describe', 'system', 'diff text', { CLAUDECODE: '1' })
    expect(launch.command).toBe('codex')
    expect(launch.args).toEqual(['exec', '--skip-git-repo-check', '-s', 'read-only', '--model', 'gpt-5'])
    expect(launch.input).toContain('system')
    expect(launch.input).toContain('describe')
    expect(launch.input).toContain('diff text')
    expect(launch.env.CLAUDECODE).toBeUndefined()
    expect(launch.env.MAX_THINKING_TOKENS).toBeUndefined()
  })
})
