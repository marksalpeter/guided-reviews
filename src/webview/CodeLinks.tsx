import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { computeNewLineNumber, type ChangeData, type EventMap } from 'react-diff-view'
import type { ColumnRange, HostMessage, Lookup, Reference, ViewMessage } from '../core/protocol.js'
import { columnAt, isLinkModifier, isLinkModifierKey, rangeIn, wordAt } from './links.js'
import { Progress } from './Progress.js'
import { post } from './vscodeApi.js'

/** answerTimeoutMs is how long a language server is given before its silence counts as no answer. */
const answerTimeoutMs = 10_000

/** tipGraceMs is how long the callers tooltip outlives the pointer leaving it and its word. */
const tipGraceMs = 300

/** messageMs is how long a "nothing found" note stays up. */
const messageMs = 2000

/** linkHighlight names the CSS highlight that underlines the symbol under the pointer. */
const linkHighlight = 'gr-link'

/** CodeLinksProvider holds the ⌘-hover state for the whole diff: one underline, one tooltip, one click waiting. */
export const CodeLinksProvider = ({ version, children }: { version: string; children: ReactNode }) => {
  const [tip, setTip] = useState<Tip | null>(null)
  const [waiting, setWaiting] = useState<string | null>(null)
  const links = useRef<Links>(null)
  links.current ??= new Links(setTip, setWaiting)
  const controller = links.current

  useEffect(() => controller.listen(), [controller])
  useEffect(() => controller.reset(), [controller, version])

  return (
    <LinksContext.Provider value={{ controller, waiting }}>
      {children}
      {tip && <LinkTip tip={tip} onEnter={() => controller.holdTip(tip.key)} onLeave={() => controller.holdTip(null)} />}
    </LinksContext.Provider>
  )
}

/** useCodeLinks is the code-cell events for one file, and whether a ⌘-click in it is still waiting. */
export function useCodeLinks(path: string): { events: EventMap; waiting: boolean } {
  const { controller, waiting } = useContext(LinksContext)
  const [events] = useState<EventMap>(() => ({
    onMouseMove: ({ change }, event) => controller?.move(pointerOf(path, change, event)),
    onMouseLeave: () => controller?.leave(),
    onClick: ({ change }, event) => controller?.click(pointerOf(path, change, event), event),
  }))
  return { events, waiting: waiting === path }
}

/** LinkTip is the tooltip under a declaration listing its callers, or a note that nothing was found. */
export const LinkTip = ({ tip, onEnter, onLeave }: { tip: Tip; onEnter: () => void; onLeave: () => void }) => {
  const below = tip.anchor.bottom < window.innerHeight / 2
  const style = {
    left: Math.max(8, Math.min(tip.anchor.left, window.innerWidth - 488)),
    ...(below ? { top: tip.anchor.bottom + 4 } : { bottom: window.innerHeight - tip.anchor.top + 4 }),
  }
  return (
    <div className="gr-tip" style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {tip.kind === 'message' ? <div className="gr-tip-note">{tip.text}</div> : <Callers name={tip.name} references={tip.references} />}
    </div>
  )
}

/** Callers lists a declaration's uses by file; each row opens its call site beside the review. */
const Callers = ({ name, references }: { name: string; references: Reference[] | null }) => {
  if (references === null) {
    return (
      <>
        <div className="gr-tip-head">{name}</div>
        <Progress label={`Finding references to ${name}`} />
      </>
    )
  }
  if (references.length === 0) {
    return <div className="gr-tip-note">No references</div>
  }
  return (
    <>
      <div className="gr-tip-head">
        {references.length} reference{references.length === 1 ? '' : 's'}
      </div>
      <div className="gr-tip-list">
        {byPath(references).map(([path, uses]) => (
          <div className="gr-tip-group" key={path}>
            <div className="gr-tip-path">{path}</div>
            {uses.map(use => (
              <button
                className="gr-tip-row"
                key={`${use.line}:${use.location.character}`}
                onClick={() => post({ type: 'openLocation', location: use.location })}
              >
                <span className="gr-tip-line">{use.line}</span>
                <span className="gr-tip-text">{use.text}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

/** Links follows the pointer across the diff and asks the host about each word it rests on while ⌘ is held. */
class Links {
  private lookups = new Map<string, Promise<Lookup>>()
  private callers = new Map<string, Promise<Reference[]>>()
  private linked: Word | null = null
  private pointer: Pointer | null = null
  private held = false
  private waitingFor: string | null = null
  private tip: Tip | null = null
  private closing = 0
  private setTip: (update: Tip | null | ((tip: Tip | null) => Tip | null)) => void
  private setWaiting: (path: string | null) => void

  constructor(setTip: Links['setTip'], setWaiting: Links['setWaiting']) {
    this.setTip = setTip
    this.setWaiting = setWaiting
  }

  /** listen follows the modifier key, Esc, and scrolling for as long as the diff is mounted. */
  listen(): () => void {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.closeTip()
      } else if (isLinkModifierKey(event.key)) {
        this.held = true
        if (this.pointer) {
          this.move({ ...this.pointer, held: true })
        }
      }
    }
    const up = (event: KeyboardEvent) => {
      if (isLinkModifierKey(event.key)) {
        this.held = false
        this.unlink()
      }
    }
    const away = () => {
      this.held = false
      this.unlink()
    }
    // a tooltip placed against a word stays put on screen, so it goes when the word moves
    const scrolled = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.gr-tip')) {
        return
      }
      this.unlink()
      this.closeTip()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', away)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', away)
      window.removeEventListener('scroll', scrolled, true)
    }
  }

  /** reset forgets every answer, since they belong to the commit that was under review. */
  reset(): void {
    this.lookups.clear()
    this.callers.clear()
    this.unlink()
    this.closeTip()
    this.waitingFor = null
    this.setWaiting(null)
  }

  /** move underlines the word under the pointer once the server says it leads somewhere. */
  move(pointer: Pointer): void {
    this.pointer = pointer
    this.held = pointer.held
    const word = wordUnder(pointer)
    this.holdTip(word?.key ?? null)
    if (!pointer.held || !word) {
      this.unlink()
      return
    }
    if (this.linked?.key === word.key) {
      return
    }
    this.unlink()
    this.linked = word
    void this.lookup(word).then(lookup => {
      if (this.linked?.key !== word.key || !this.held || lookup.kind === 'none') {
        return
      }
      this.underline(word, lookup.range)
      if (lookup.kind === 'declaration') {
        this.showCallers(word, lookup.range)
      }
    })
  }

  /** leave drops the underline when the pointer leaves the code. */
  leave(): void {
    this.unlink()
    this.holdTip(null)
  }

  /** click follows a link: a definition opens beside the review, a declaration lists its callers. */
  click(pointer: Pointer, event: MouseEvent): void {
    const word = pointer.held ? wordUnder(pointer) : null
    if (!word) {
      return
    }
    event.preventDefault()
    this.waitingFor = word.key
    this.setWaiting(word.path)
    void this.lookup(word).then(lookup => {
      if (this.waitingFor !== word.key) {
        return
      }
      this.waitingFor = null
      this.setWaiting(null)
      if (lookup.kind === 'definition') {
        post({ type: 'openLocation', location: lookup.target })
      } else if (lookup.kind === 'declaration') {
        this.showCallers(word, lookup.range)
      } else {
        this.showMessage(word, 'No definition found')
      }
    })
  }

  /** holdTip keeps the tooltip while the pointer is on its word or on it, and lets it go a moment after. */
  holdTip(key: string | null): void {
    // a note keeps its own clock, wherever the pointer goes
    if (this.tip?.kind !== 'callers') {
      return
    }
    window.clearTimeout(this.closing)
    if (key !== this.tip.key) {
      this.closing = window.setTimeout(() => this.closeTip(), tipGraceMs)
    }
  }

  /** lookup asks the host once per word; the language server caches the rest. */
  private lookup(word: Word): Promise<Lookup> {
    let lookup = this.lookups.get(word.key)
    if (!lookup) {
      lookup = ask<Lookup>(id => ({ type: 'lookup', id, ...word.at }), { kind: 'none' })
      this.lookups.set(word.key, lookup)
    }
    return lookup
  }

  /** showCallers opens the tooltip under a declaration, then fills it once the references arrive. */
  private showCallers(word: Word, range: ColumnRange): void {
    if (this.tip?.key === word.key && this.tip.kind === 'callers') {
      return
    }
    const anchor = rangeIn(word.cell, range)?.getBoundingClientRect()
    if (!anchor) {
      return
    }
    this.openTip({ kind: 'callers', key: word.key, anchor, name: word.text.slice(range.start, range.end), references: null })
    let callers = this.callers.get(word.key)
    if (!callers) {
      callers = ask<Reference[]>(id => ({ type: 'references', id, ...word.at }), [])
      this.callers.set(word.key, callers)
    }
    void callers.then(references =>
      this.setTip(tip => (tip?.key === word.key && tip.kind === 'callers' ? { ...tip, references } : tip)),
    )
  }

  /** showMessage puts a short note under a word, and takes it away on its own. */
  private showMessage(word: Word, text: string): void {
    const anchor = rangeIn(word.cell, word.range)?.getBoundingClientRect()
    if (!anchor) {
      return
    }
    this.openTip({ kind: 'message', key: word.key, anchor, text })
    window.clearTimeout(this.closing)
    this.closing = window.setTimeout(() => this.closeTip(), messageMs)
  }

  /** openTip replaces whatever tooltip is up. */
  private openTip(tip: Tip): void {
    window.clearTimeout(this.closing)
    this.tip = tip
    this.setTip(tip)
  }

  /** closeTip takes the tooltip down. */
  private closeTip(): void {
    window.clearTimeout(this.closing)
    this.tip = null
    this.setTip(null)
  }

  /** underline marks the symbol the server matched, with the pointer cursor over its cell. */
  private underline(word: Word, range: ColumnRange): void {
    const span = rangeIn(word.cell, range)
    if (!span || !highlights()) {
      return
    }
    highlights()?.set(linkHighlight, new Highlight(span))
    word.cell.classList.add('gr-linked')
  }

  /** unlink clears the underline and forgets the word it was on. */
  private unlink(): void {
    highlights()?.delete(linkHighlight)
    this.linked?.cell.classList.remove('gr-linked')
    this.linked = null
  }
}

/** ask posts one request and waits for the host's answer to it, giving up after a while. */
function ask<T>(message: (id: number) => ViewMessage, fallback: T): Promise<T> {
  const id = nextId++
  return new Promise<T>(resolve => {
    const timer = window.setTimeout(() => settle(fallback), answerTimeoutMs)
    const settle = (value: T) => {
      window.clearTimeout(timer)
      window.removeEventListener('message', listener)
      resolve(value)
    }
    const listener = (event: MessageEvent<HostMessage>) => {
      const data = event.data
      if (data.type === 'lookup' && data.id === id) {
        settle(data.lookup as T)
      } else if (data.type === 'references' && data.id === id) {
        settle(data.references as T)
      }
    }
    window.addEventListener('message', listener)
    post(message(id))
  })
}

/** nextId numbers requests, so each answer finds the one that asked. */
let nextId = 1

/** wordUnder is the new-side identifier beneath a pointer; deleted lines are not on disk to ask about. */
function wordUnder(pointer: Pointer): Word | null {
  const { change, cell, path } = pointer
  const line = change ? computeNewLineNumber(change) : -1
  if (!change || line <= 0) {
    return null
  }
  const column = columnAt(cell, pointer.x, pointer.y)
  const range = column === null ? null : wordAt(change.content, column)
  if (!range) {
    return null
  }
  return {
    key: `${path}\u0000${line}\u0000${range.start}`,
    path,
    range,
    cell,
    text: change.content,
    at: { path, line, character: range.start },
  }
}

/** pointerOf captures a mouse event over a code cell. */
function pointerOf(path: string, change: ChangeData | null, event: MouseEvent<HTMLElement>): Pointer {
  return { path, change, cell: event.currentTarget, x: event.clientX, y: event.clientY, held: isLinkModifier(event) }
}

/** byPath groups references under the file they sit in, keeping the host's order. */
function byPath(references: Reference[]): [string, Reference[]][] {
  const groups = new Map<string, Reference[]>()
  for (const reference of references) {
    groups.set(reference.path, [...(groups.get(reference.path) ?? []), reference])
  }
  return [...groups]
}

/** highlights is the CSS highlight registry, missing outside a real browser. */
function highlights(): HighlightRegistry | undefined {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined
}

/** LinksContext hands the controller to every file without threading it through the tree. */
const LinksContext = createContext<{ controller: Links | null; waiting: string | null }>({ controller: null, waiting: null })

/** Pointer is where the mouse is over a code cell, and whether the link modifier is down. */
interface Pointer {
  path: string
  change: ChangeData | null
  cell: HTMLElement
  x: number
  y: number
  held: boolean
}

/** Word is one identifier on one new-side line, keyed so repeat hovers reuse its answer. */
interface Word {
  key: string
  path: string
  range: ColumnRange
  cell: HTMLElement
  text: string
  at: { path: string; line: number; character: number }
}

/** Tip is the tooltip on screen: a declaration's callers, or a short note. */
export type Tip =
  | { kind: 'callers'; key: string; anchor: DOMRect; name: string; references: Reference[] | null }
  | { kind: 'message'; key: string; anchor: DOMRect; text: string }
