/** extensionId addresses this extension inside an editor deep link. */
export const extensionId = 'marksalpeter.guided-reviews'

/** reviewUri is the deep link that opens the branch review for one repository, on one comment when named. */
export function reviewUri(scheme: string, repoRoot: string, threadId?: string): string {
  const target = threadId ? `&thread=${encodeURIComponent(threadId)}` : ''
  return `${scheme}://${extensionId}/review?repo=${encodeURIComponent(repoRoot)}${target}`
}

/** openCommand is the platform command that hands a uri to the editor registered for its scheme. */
export function openCommand(platform: string, uri: string): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'open', args: [uri] }
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', uri] }
  }
  return { command: 'xdg-open', args: [uri] }
}
