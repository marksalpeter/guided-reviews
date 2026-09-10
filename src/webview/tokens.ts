/** editClassName is react-diff-view's wrapper for a word-level changed run. */
const editClassName = 'diff-code-edit'

/** styleOf converts Shiki's inline style string into a React style object. */
export function styleOf(token: StyledToken): Record<string, string> | undefined {
  const declarations = token.properties?.style
  if (typeof declarations !== 'string' || declarations.trim().length === 0) {
    return undefined
  }
  const style: Record<string, string> = {}
  for (const declaration of declarations.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator === -1) {
      continue
    }
    const property = declaration.slice(0, separator).trim()
    const value = declaration.slice(separator + 1).trim()
    if (property && value) {
      style[camelCase(property)] = value
    }
  }
  return Object.keys(style).length > 0 ? style : undefined
}

/** classNameOf reads whichever class shape the token carries. */
export function classNameOf(token: StyledToken): string | undefined {
  const raw = token.properties?.className
  return Array.isArray(raw) ? raw.join(' ') : raw
}

/** markClassName names the wrapper for edit and mark tokens, which carry no properties. */
export function markClassName(token: StyledToken): string | undefined {
  if (token.type === 'edit') {
    return editClassName
  }
  if (token.type === 'mark') {
    return `diff-code-mark diff-code-mark-${String(token.markType ?? '')}`
  }
  return undefined
}

/** camelCase converts a CSS property name to its React style key. */
function camelCase(property: string): string {
  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** StyledToken is the subset of a token this module reads. */
export interface StyledToken {
  type: string
  markType?: unknown
  properties?: { style?: unknown; className?: string | string[] }
}
