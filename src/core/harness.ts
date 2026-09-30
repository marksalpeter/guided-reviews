import type { AgentCommand } from './guide.js'

/** detectAgentCommand reads the markers a harness puts on the process it spawned. */
export function detectAgentCommand(env: NodeJS.ProcessEnv): AgentCommand {
  // Codex is the only other preset. Cursor's agent sets CURSOR_AGENT and still uses claude.
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) {
    return 'codex'
  }
  return 'claude'
}
