/** extensionId addresses this extension inside an editor deep link. */
export const extensionId = 'marksalpeter.guided-reviews'

/** reviewUri is the deep link that opens the branch review for one repository, on one comment when named. */
export function reviewUri(scheme: string, repoRoot: string, threadId?: string): string {
  const target = threadId ? `&thread=${encodeURIComponent(threadId)}` : ''
  return `${scheme}://${extensionId}/review?repo=${encodeURIComponent(repoRoot)}${target}`
}

/** browserUri asks the editor to open one review page in its embedded browser. */
export function browserUri(scheme: string, pageUrl: string): string {
  return `${scheme}://${extensionId}/browser?url=${encodeURIComponent(pageUrl)}`
}

/** reviewPageUrl accepts only this machine's review server, never an arbitrary link. */
export function reviewPageUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1'
    if ((url.protocol === 'http:' || url.protocol === 'https:') && local) {
      return url.toString()
    }
  } catch {
    return undefined
  }
  return undefined
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
