import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ColumnRange, Peek, Reference } from '../core/protocol.js'
import { activeTheme, languageForPath, loadRefractor, plaintext, type HastNode } from './highlight.js'
import { Progress } from './Progress.js'
import { classNameOf, styleOf } from './tokens.js'

/** CallersPeek is the editor's references peek: the uses on one side, the selected site on the other. */
export const CallersPeek = ({
  name,
  references,
  selected,
  preview,
  onSelect,
  onClose,
}: {
  name: string
  references: Reference[] | null
  selected: string | null
  preview: Peek | null | undefined
  onSelect: (reference: Reference) => void
  onClose: () => void
}) => {
  if (references === null) {
    return (
      <PeekFrame title={name} onClose={onClose}>
        <Progress label={`Finding references to ${name}`} />
      </PeekFrame>
    )
  }
  if (references.length === 0) {
    return (
      <PeekFrame title="References" onClose={onClose}>
        <div className="gr-peek-note">No references</div>
      </PeekFrame>
    )
  }
  const current = references.find(use => referenceKey(use) === selected) ?? references[0]
  const place = current ? splitPath(current.path) : { file: 'References', dir: '' }
  const count = `${references.length} reference${references.length === 1 ? '' : 's'}`
  return (
    <PeekFrame title={place.file} detail={place.dir} meta={count} onClose={onClose}>
      <div className="gr-peek-body">
        <div className="gr-peek-results">
          {byPath(references).map(([path, uses]) => {
            const group = splitPath(path)
            return (
              <div className="gr-peek-group" key={path}>
                <div className="gr-peek-path">
                  <span className="gr-peek-file">{group.file}</span>
                  {group.dir && <span className="gr-peek-dirname">{group.dir}</span>}
                </div>
                {uses.map(use => (
                  <button
                    type="button"
                    className={selected === referenceKey(use) ? 'gr-peek-row selected' : 'gr-peek-row'}
                    key={referenceKey(use)}
                    onClick={() => onSelect(use)}
                  >
                    <span className="gr-peek-line">{use.line}</span>
                    <span className="gr-peek-text">
                      <Matched text={use.text} match={use.match} />
                    </span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
        {preview ? (
          <PeekEditor peek={preview} />
        ) : (
          <div className="gr-peek-editor">{preview === null ? <div className="gr-peek-note">No preview</div> : <Progress label="Opening reference" />}</div>
        )}
      </div>
    </PeekFrame>
  )
}

/** DefinitionPeek is the editor's peek definition: the file, and the lines around the symbol. */
export const DefinitionPeek = ({ peek, onClose }: { peek: Peek | null | undefined; onClose: () => void }) => {
  if (!peek) {
    return (
      <PeekFrame title="Definition" onClose={onClose}>
        {peek === null ? <div className="gr-peek-note">No definition found</div> : <Progress label="Opening definition" />}
      </PeekFrame>
    )
  }
  const { file, dir } = splitPath(peek.path)
  return (
    <PeekFrame title={file} detail={dir} onClose={onClose}>
      <PeekEditor peek={peek} />
    </PeekFrame>
  )
}

/** referenceKey identifies one use so a click can show its preview. */
export function referenceKey(reference: Reference): string {
  return `${reference.location.uri}\0${reference.line}\0${reference.location.character}`
}

/** PeekFrame is the title bar and body chrome the editor's peek view uses. */
const PeekFrame = ({
  title,
  detail,
  meta,
  onClose,
  children,
}: {
  title: string
  detail?: string
  meta?: string
  onClose: () => void
  children: ReactNode
}) => (
  <>
    <div className="gr-peek-title">
      <span className="gr-peek-filename">{title}</span>
      {detail && <span className="gr-peek-dirname">{detail}</span>}
      <span className="gr-peek-spacer" />
      {meta && <span className="gr-peek-meta">{meta}</span>}
      <button type="button" className="gr-peek-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
    {children}
  </>
)

/** PeekEditor draws the peeked lines with their numbers, highlighting the match once the grammar is ready. */
const PeekEditor = ({ peek }: { peek: Peek }) => {
  const plain = peek.text.split('\n')
  const matchIndex = peek.line - peek.startLine
  const editor = useRef<HTMLDivElement>(null)
  const [highlighted, setHighlighted] = useState<HastNode[][] | null>(null)

  useEffect(() => {
    const root = editor.current
    const row = root?.querySelector('.is-match')
    if (!root || !(row instanceof HTMLElement)) {
      return
    }
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top < root.scrollTop) {
      root.scrollTop = top
    } else if (bottom > root.scrollTop + root.clientHeight) {
      root.scrollTop = bottom - root.clientHeight
    }
  }, [peek])

  useEffect(() => {
    const language = languageForPath(peek.path)
    if (language === plaintext) {
      return
    }
    if (typeof window.matchMedia !== 'function') {
      return
    }
    let live = true
    void loadRefractor([peek.path], activeTheme())
      .then(refractor => {
        if (live) {
          setHighlighted(splitLines(refractor.highlight(peek.text, language)))
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [peek])

  return (
    <div className="gr-peek-editor" ref={editor}>
      {plain.map((line, index) => (
        <div className={index === matchIndex ? 'gr-peek-rowline is-match' : 'gr-peek-rowline'} key={peek.startLine + index}>
          <span className="gr-peek-gutter">{peek.startLine + index}</span>
          <span className="gr-peek-code">
            {index === matchIndex ? <Matched text={line} match={peek.match} nodes={highlighted?.[index]} /> : <Line text={line} nodes={highlighted?.[index]} />}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Matched draws a line with the symbol marked the way a peek result marks it. */
const Matched = ({ text, match, nodes }: { text: string; match: ColumnRange; nodes?: HastNode[] }) => {
  if (nodes && nodes.length > 0) {
    return <>{renderNodes(markColumns(nodes, match.start, match.end))}</>
  }
  const start = Math.max(0, Math.min(match.start, text.length))
  const end = Math.max(start, Math.min(match.end, text.length))
  return (
    <>
      {text.slice(0, start)}
      <mark className="gr-peek-match">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  )
}

/** Line draws one peeked line, plain until its grammar has coloured it. */
const Line = ({ text, nodes }: { text: string; nodes?: HastNode[] }) => {
  if (!nodes || nodes.length === 0) {
    return text
  }
  return <>{renderNodes(nodes)}</>
}

/** byPath groups references under the file they sit in, keeping the host's order. */
function byPath(references: Reference[]): [string, Reference[]][] {
  const groups = new Map<string, Reference[]>()
  for (const reference of references) {
    groups.set(reference.path, [...(groups.get(reference.path) ?? []), reference])
  }
  return [...groups]
}

/** splitPath separates the filename a peek title shows from the directory beside it. */
function splitPath(path: string): { file: string; dir: string } {
  const slash = path.lastIndexOf('/')
  if (slash < 0) {
    return { file: path, dir: '' }
  }
  return { file: path.slice(slash + 1), dir: path.slice(0, slash) }
}

/** splitLines breaks a highlighted file into one node list per line. */
function splitLines(nodes: readonly HastNode[]): HastNode[][] {
  const lines: HastNode[][] = [[]]
  const push = (node: HastNode) => {
    lines[lines.length - 1]?.push(node)
  }
  for (const node of nodes) {
    if (node.type !== 'text' || !node.value?.includes('\n')) {
      push(node)
      continue
    }
    const parts = node.value.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([])
      }
      if (part) {
        push({ type: 'text', value: part })
      }
    })
  }
  return lines
}

/** markColumns wraps the columns a symbol occupies, splitting a token when the match falls inside it. */
export function markColumns(nodes: readonly HastNode[], start: number, end: number): HastNode[] {
  if (end <= start) {
    return [...nodes]
  }
  const out: HastNode[] = []
  let marked: HastNode[] = []
  let cursor = 0
  const flush = () => {
    if (marked.length === 0) {
      return
    }
    out.push({ type: 'element', properties: { className: 'gr-peek-match' }, children: marked })
    marked = []
  }
  for (const node of nodes) {
    const value = textOf(node)
    const nodeStart = cursor
    const nodeEnd = cursor + value.length
    cursor = nodeEnd
    if (nodeEnd <= start || nodeStart >= end) {
      flush()
      out.push(node)
      continue
    }
    const localStart = Math.max(0, start - nodeStart)
    const localEnd = Math.min(value.length, end - nodeStart)
    if (node.type === 'text') {
      const before = value.slice(0, localStart)
      const middle = value.slice(localStart, localEnd)
      const after = value.slice(localEnd)
      if (before) {
        flush()
        out.push({ type: 'text', value: before })
      }
      if (middle) {
        marked.push({ type: 'text', value: middle })
      }
      flush()
      if (after) {
        out.push({ type: 'text', value: after })
      }
      continue
    }
    if (localStart === 0 && localEnd === value.length) {
      marked.push(node)
      continue
    }
    flush()
    out.push(node)
  }
  flush()
  return out
}

/** renderNodes draws highlighted tokens, keeping the colours the grammar assigned. */
function renderNodes(nodes: readonly HastNode[]): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, index))
}

/** renderNode draws one syntax node. */
function renderNode(node: HastNode, index: number): ReactNode {
  if (node.type === 'text') {
    return node.value
  }
  return (
    <span key={index} className={classNameOf(node)} style={styleOf(node)}>
      {node.children?.map((child, at) => renderNode(child, at))}
    </span>
  )
}

/** textOf is the text a node contributes to a line. */
function textOf(node: HastNode): string {
  if (node.type === 'text') {
    return node.value ?? ''
  }
  return (node.children ?? []).map(textOf).join('')
}
