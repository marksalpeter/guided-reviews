/** ColorScheme is the browser review's light or dark palette. The editor follows its own theme. */
export type ColorScheme = 'light' | 'dark'

const yearSeconds = 60 * 60 * 24 * 365

/** schemeFromCookie reads a saved choice, ignoring anything that is not light or dark. */
export function schemeFromCookie(cookie: string): ColorScheme | undefined {
  const match = /(?:^|;\s*)gr-scheme=(light|dark)(?:;|$)/.exec(cookie)
  return match ? (match[1] as ColorScheme) : undefined
}

/** schemeCookie is the document.cookie assignment that remembers a choice across review launches. */
export function schemeCookie(scheme: ColorScheme): string {
  return `gr-scheme=${scheme}; Path=/; Max-Age=${yearSeconds}; SameSite=Lax`
}

/** effectiveScheme uses the saved choice, and the system scheme only when the reader has not picked. */
export function effectiveScheme(stored: ColorScheme | undefined, prefersLight: boolean): ColorScheme {
  return stored ?? (prefersLight ? 'light' : 'dark')
}

/** readScheme returns the choice saved for this machine, if there is one. */
export function readScheme(): ColorScheme | undefined {
  return typeof document === 'undefined' ? undefined : schemeFromCookie(document.cookie)
}

/** systemPrefersLight is the operating system's color scheme. */
export function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
}

/** currentScheme is what the page should paint right now. */
export function currentScheme(): ColorScheme {
  if (typeof document !== 'undefined') {
    if (document.body.classList.contains('gr-light')) {
      return 'light'
    }
    if (document.body.classList.contains('gr-dark')) {
      return 'dark'
    }
  }
  return effectiveScheme(readScheme(), systemPrefersLight())
}

/** applyScheme stamps the palette on the body so the stylesheet and the highlighter agree. */
export function applyScheme(scheme: ColorScheme): void {
  document.body.classList.toggle('gr-light', scheme === 'light')
  document.body.classList.toggle('gr-dark', scheme === 'dark')
}

/** storeScheme remembers a reader's choice and paints it. */
export function storeScheme(scheme: ColorScheme): void {
  document.cookie = schemeCookie(scheme)
  applyScheme(scheme)
}
