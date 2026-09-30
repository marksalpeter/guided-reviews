import { readFile } from 'node:fs/promises'

/** packed maps a webview path to a file the compiled binary embedded. */
const packed = new Map<string, string>()

/** setPackedAssets registers the webview files embedded in the compiled binary. */
export function setPackedAssets(files: Record<string, string>): void {
  packed.clear()
  for (const [name, path] of Object.entries(files)) {
    packed.set(name, path)
  }
}

/** readPacked reads one embedded webview file, when the binary has one. */
export async function readPacked(name: string): Promise<Buffer | undefined> {
  const path = packed.get(name)
  if (!path) {
    return undefined
  }
  return readFile(path)
}
