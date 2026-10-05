import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseDiff, type FileData } from 'react-diff-view'
import { anchorOf, isTestPath, orderPaths, placeTests } from '../core/ordering.js'
import type { HostMessage, LoadedDiff, ReviewPayload } from '../core/protocol.js'
import type { Guide, GuideGroup, Thread } from '../core/types.js'
import { BranchBar } from './BranchBar.js'
import { CodeLinksProvider } from './CodeLinks.js'
import { CommentThread, threadElementId } from './CommentThread.js'
import { sourceLines } from './expand.js'
import { FileDiff, fileAnchorId, pathOf } from './FileDiff.js'
import { FileList, isReviewed, reviewedCount } from './FileList.js'
import { GuideStatus } from './GuideStatus.js'
import { activeTheme, loadRefractor, type RefractorLike } from './highlight.js'
import { Progress } from './Progress.js'
import { applyScheme, currentScheme, readScheme, storeScheme, type ColorScheme } from './scheme.js'
import { browserHost, loadViewState, post, saveViewState } from './vscodeApi.js'

/** withPath adds or drops one path from a set, leaving the set it was given alone. */
export function withPath(paths: ReadonlySet<string>, path: string, present: boolean): Set<string> {
  const next = new Set(paths)
  present ? next.add(path) : next.delete(path)
  return next
}

/** testsShut adds every test the reader has not opened. */
export function testsShut(paths: readonly string[], collapsed: ReadonlySet<string>, opened: ReadonlySet<string>): Set<string> {
  const next = new Set(collapsed)
  for (const path of paths) {
    if (isTestPath(path) && !opened.has(path)) next.add(path)
  }
  return next
}

/** focusRevealFrames is how many frames a deep-linked thread is given to render before giving up. */
const focusRevealFrames = 60

/** focusHighlightMs is how long a revealed thread stays marked. */
const focusHighlightMs = 2500

/** App is the review shell: a toolbar, then chapters of summary-beside-diff. */
export const App = () => {
  const [payload, setPayload] = useState<ReviewPayload | null>(null)
  const [fatal, setFatal] = useState('')
  const [mode, setMode] = useState<Mode>(loadViewState().mode ?? 'guided')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(loadViewState().collapsed ?? []))
  const [openedTests, setOpenedTests] = useState<Set<string>>(new Set(loadViewState().openedTests ?? []))
  // a deep-linked comment must be on screen even in a file the reader has collapsed or ticked off
  const [forced, setForced] = useState<Set<string>>(new Set())
  // base texts arrive one blob at a time, and outlive the payload that asked for them
  const [sources, setSources] = useState<Record<string, string[]>>({})

  const addSource = useCallback(
    (blob: string, text: string) => setSources(previous => ({ ...previous, [blob]: sourceLines(text) })),
    [],
  )
  useHostMessages(setPayload, setFatal, addSource)
  useEffect(() => saveViewState({ mode, collapsed: [...collapsed], openedTests: [...openedTests] }), [mode, collapsed, openedTests])

  // the host sends a fresh payload object on every action, so both memos key on the text they parse
  const files = useMemo(() => (payload ? parseDiff(payload.review.diff) : []), [payload?.review.diff])
  const shut = useMemo(() => testsShut(files.map(pathOf), collapsed, openedTests), [files, collapsed, openedTests])
  const scheme = useBrowserScheme()
  const refractor = useRefractor(files, scheme?.value)
  const chapters = useChapters(files, payload?.review.state.guide, mode)
  const scroller = useRef<HTMLDivElement>(null)
  useScrollAnchor(scroller, chapters)
  useChapterBand(scroller, chapters)
  useFocusedThread(payload, setCollapsed, setForced, setOpenedTests)

  const jumpToFile = useCallback((path: string) => {
    document.getElementById(fileAnchorId(path))?.scrollIntoView({ block: 'start' })
  }, [])

  // a reviewed file is shut without being collapsed, so the toggle flips what is on screen
  // rather than one of the two things that can hold it shut
  const toggleCollapsed = useCallback((path: string, hidden: boolean) => {
    setCollapsed(previous => withPath(previous, path, !hidden))
    setForced(previous => withPath(previous, path, hidden))
    if (isTestPath(path)) setOpenedTests(previous => withPath(previous, path, hidden))
  }, [])

  if (fatal) {
    return <div className="gr-empty">{fatal}</div>
  }
  if (!payload) {
    return (
      <div className="gr-loading">
        <Progress label="Loading review" />
      </div>
    )
  }

  const { review } = payload
  const { state } = review
  // the payload crosses a process boundary, so never assume the map arrived
  const reviewedBlobs = state.reviewedBlobs ?? {}
  const outdated = state.threads.filter(thread => thread.status === 'outdated' && thread.state === 'open')

  return (
    <div className="gr-shell">
      <Toolbar selector={payload.selector} mode={mode} onMode={setMode} scheme={scheme} />

      <CodeLinksProvider version={state.refs.headSha}>
        <div className="gr-main" ref={scroller}>
          {chapters.length === 0 && <div className="gr-empty">No changes between these commits.</div>}
          {chapters.map(chapter => (
            <section className="gr-chapter" key={chapter.id}>
              <ChapterSummary
                group={chapter.group}
                paths={chapter.files.map(pathOf)}
                files={review.files}
                reviewedBlobs={reviewedBlobs}
                onJumpToFile={jumpToFile}
              />
              <div className="gr-chapter-files">
                {chapter.files.map(file => {
                  const path = pathOf(file)
                  const meta = review.files.find(f => f.path === path)
                  return (
                    <FileDiff
                      key={path}
                      file={file}
                      meta={meta}
                      threads={threadsForPath(state.threads, path)}
                      refractor={refractor}
                      source={meta?.oldBlob ? sources[meta.oldBlob] : undefined}
                      reviewed={isReviewed(reviewedBlobs[path], meta?.newBlob)}
                      collapsed={shut.has(path)}
                      forced={forced.has(path)}
                      onToggleCollapsed={hidden => toggleCollapsed(path, hidden)}
                      onToggleReviewed={() =>
                        isReviewed(reviewedBlobs[path], meta?.newBlob)
                          ? post({ type: 'unmarkReviewed', path })
                          : post({ type: 'markReviewed', path, blob: meta?.newBlob ?? '' })
                      }
                    />
                  )
                })}
              </div>
            </section>
          ))}
          {outdated.length > 0 && <OutdatedThreads threads={outdated} />}
        </div>
      </CodeLinksProvider>
      <GuideStatus state={state} busy={payload.guideBusy} files={review.files} />
    </div>
  )
}

/** Toolbar is the sticky header: refs on the left, then the view toggle, the scheme toggle, and Submit. */
const Toolbar = ({
  selector,
  mode,
  onMode,
  scheme,
}: {
  selector: ReviewPayload['selector']
  mode: Mode
  onMode: (mode: Mode) => void
  scheme?: BrowserScheme
}) => (
  <div className="gr-toolbar">
    <BranchBar selector={selector} />
    <span className="gr-spacer" />
    <div className="gr-modes">
      <button aria-pressed={mode === 'guided'} onClick={() => onMode('guided')}>
        Guided
      </button>
      <button aria-pressed={mode === 'diff'} onClick={() => onMode('diff')}>
        Diff
      </button>
    </div>
    {scheme && (
      <div className="gr-scheme" role="group" aria-label="Color scheme">
        <button aria-pressed={scheme.value === 'light'} aria-label="Light" title="Light" onClick={() => scheme.choose('light')}>
          <SunIcon />
        </button>
        <button aria-pressed={scheme.value === 'dark'} aria-label="Dark" title="Dark" onClick={() => scheme.choose('dark')}>
          <MoonIcon />
        </button>
      </div>
    )}
    {browserHost && (
      <button className="gr-submit" onClick={() => post({ type: 'submit' })}>
        Submit
      </button>
    )}
  </div>
)

/** SunIcon is the light segment of the scheme pill. */
const SunIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4 11.5 4.5M4.5 11.5 3.4 12.6"
    />
  </svg>
)

/** MoonIcon is the dark segment of the scheme pill. */
const MoonIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      d="M9.4 2.2a5.2 5.2 0 1 0 4.4 7.6A4.3 4.3 0 0 1 9.4 2.2z"
    />
  </svg>
)

/** BrowserScheme is the browser host's palette and the way to change it. */
interface BrowserScheme {
  value: ColorScheme
  choose: (scheme: ColorScheme) => void
}

/** useBrowserScheme follows the system until the reader picks, and is absent inside the editor. */
function useBrowserScheme(): BrowserScheme | undefined {
  const [scheme, setScheme] = useState<ColorScheme>(currentScheme)
  useEffect(() => {
    if (browserHost) {
      applyScheme(scheme)
    }
  }, [scheme])
  useEffect(() => {
    if (!browserHost) {
      return
    }
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      if (readScheme() !== undefined) {
        return
      }
      const next: ColorScheme = media.matches ? 'light' : 'dark'
      applyScheme(next)
      setScheme(next)
    }
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
  if (!browserHost) {
    return undefined
  }
  return {
    value: scheme,
    choose(next) {
      storeScheme(next)
      setScheme(next)
    },
  }
}

/** ChapterSummary is the left column: a chapter heading when the guide has one, then its files. */
const ChapterSummary = ({
  group,
  paths,
  files,
  reviewedBlobs,
  onJumpToFile,
}: {
  group?: GuideGroup
  paths: readonly string[]
  files: LoadedDiff['files']
  reviewedBlobs: Record<string, string>
  onJumpToFile: (path: string) => void
}) => {
  const allReviewed = paths.length > 0 && reviewedCount(paths, files, reviewedBlobs) === paths.length
  return (
  <div className="gr-chapter-summary">
    <div className="gr-chapter-sticky">
      {group && (
        <>
          <div className="gr-group-title">{group.title}</div>
          <div className="gr-chapter-progress">
            <span>
              {String(reviewedCount(paths, files, reviewedBlobs)).padStart(2, '0')} / {String(paths.length).padStart(2, '0')}
            </span>
            <label className="gr-reviewed">
              <input
                type="checkbox"
                checked={allReviewed}
                onChange={() =>
                  post({
                    type: 'reviewFiles',
                    files: paths.map(path => ({ path, blob: files.find(file => file.path === path)?.newBlob ?? '' })),
                    reviewed: !allReviewed,
                  })
                }
              />
              Reviewed
            </label>
          </div>
          <div className="gr-group-summary">{group.summary}</div>
        </>
      )}
      <FileList paths={paths} files={files} reviewedBlobs={reviewedBlobs} onSelect={onJumpToFile} />
    </div>
  </div>
  )
}

/** OutdatedThreads lists threads whose code has moved on, so they are never silently lost. */
const OutdatedThreads = ({ threads }: { threads: Thread[] }) => (
  <div className="gr-outdated-list">
    <h3>Outdated comments ({threads.length})</h3>
    {threads.map(thread => (
      <CommentThread key={thread.id} thread={thread} />
    ))}
  </div>
)

/** useFocusedThread reveals the comment a deep link named, opening the file that holds it. */
function useFocusedThread(
  payload: ReviewPayload | null,
  setCollapsed: (update: (previous: Set<string>) => Set<string>) => void,
  setForced: (update: (previous: Set<string>) => Set<string>) => void,
  setOpenedTests: (update: (previous: Set<string>) => Set<string>) => void,
): void {
  const focus = payload?.focusThread
  const threads = payload?.review.state.threads

  useEffect(() => {
    if (!focus) {
      return
    }
    const anchor = threads?.find(thread => thread.id === focus)?.anchor
    if (anchor?.kind === 'line') {
      setCollapsed(previous => {
        const next = new Set(previous)
        next.delete(anchor.path)
        return next
      })
      setForced(previous => new Set(previous).add(anchor.path))
      if (isTestPath(anchor.path)) setOpenedTests(previous => withPath(previous, anchor.path, true))
    }
    return revealThread(focus)
    // the reveal is a one-shot, so it follows the named thread and nothing else
  }, [focus])
}

/** revealThread scrolls a thread into view once it has rendered, and marks it for the reader's eye. */
function revealThread(threadId: string): () => void {
  let frames = focusRevealFrames
  let frame = 0
  let clear = 0

  const look = () => {
    const element = document.getElementById(threadElementId(threadId))
    if (!element) {
      frame = frames-- > 0 ? requestAnimationFrame(look) : 0
      return
    }
    // the file it sits in may have just expanded, so let that layout settle before gliding to it
    frame = requestAnimationFrame(() => {
      element.scrollIntoView({ block: 'center', behavior: motionPreference() })
      element.classList.add('focused')
      clear = window.setTimeout(() => element.classList.remove('focused'), focusHighlightMs)
    })
  }
  frame = requestAnimationFrame(look)

  return () => {
    cancelAnimationFrame(frame)
    window.clearTimeout(clear)
  }
}

/** motionPreference glides to a comment unless the reader has asked the system for less motion. */
function motionPreference(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** useRefractor loads only the grammars this review's files need, rendering plain until ready. */
function useRefractor(files: FileData[], scheme: ColorScheme | undefined): RefractorLike | null {
  const [refractor, setRefractor] = useState<RefractorLike | null>(null)
  const [theme, setTheme] = useState(activeTheme)
  const paths = files.map(pathOf).join('|')

  useEffect(() => {
    setTheme(activeTheme())
  }, [scheme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => setTheme(activeTheme())
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    let live = true
    void loadRefractor(paths ? paths.split('|') : [], theme).then(loaded => {
      if (live) {
        setRefractor(loaded)
      }
    })
    return () => {
      live = false
    }
  }, [paths, theme])

  return refractor
}

/** diffRange is the commit pair the page URL names, when both ends are present. */
function diffRange(): { base?: string; head?: string } {
  if (typeof location === 'undefined') {
    return {}
  }
  const params = new URLSearchParams(location.search)
  const base = params.get('base') ?? undefined
  const head = params.get('head') ?? undefined
  return base && head ? { base, head } : {}
}

/** useHostMessages subscribes to the extension host and announces readiness once. */
function useHostMessages(
  onReview: (payload: ReviewPayload) => void,
  onError: (message: string) => void,
  onSource: (blob: string, text: string) => void,
): void {
  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      if (event.data.type === 'review') {
        onReview(event.data.payload)
      } else if (event.data.type === 'source') {
        onSource(event.data.blob, event.data.text)
      } else if (event.data.type === 'error') {
        onError(event.data.message)
      }
    }
    window.addEventListener('message', listener)
    post({ type: 'ready', ...diffRange() })
    return () => window.removeEventListener('message', listener)
  }, [onReview, onError, onSource])
}

/** useChapters groups the diff under its guide chapters, or into one bare chapter without a guide. */
function useChapters(files: FileData[], guide: Guide | undefined, mode: Mode): Chapter[] {
  const signature = guide ? `${guide.headSha}:${guide.groups.map(group => group.id).join('|')}` : ''

  return useMemo(() => {
    const byPath = new Map(files.map(file => [pathOf(file), file]))
    const paths = placeTests(orderPaths(files.map(pathOf), mode === 'guided' ? guide : undefined))
    const filesOf = (ordered: readonly string[]) => ordered.map(path => byPath.get(path)).filter((file): file is FileData => file !== undefined)
    if (!guide || mode !== 'guided') {
      const ordered = filesOf(paths)
      return ordered.length === 0 ? [] : [{ id: 'all', files: ordered }]
    }

    const groupOf = new Map<string, string>()
    for (const group of guide.groups) {
      for (const path of group.files) groupOf.set(path, group.id)
    }
    const buckets = new Map<string, string[]>()
    for (const path of paths) {
      const anchor = anchorOf(path, paths)
      const id = (anchor && groupOf.get(anchor)) || groupOf.get(path) || 'ungrouped'
      const list = buckets.get(id) ?? []
      list.push(path)
      buckets.set(id, list)
    }

    const chapters: Chapter[] = []
    for (const group of guide.groups) {
      const grouped = filesOf(buckets.get(group.id) ?? [])
      if (grouped.length > 0) chapters.push({ id: group.id, group, files: grouped })
    }
    const rest = filesOf(buckets.get('ungrouped') ?? [])
    if (rest.length > 0) chapters.push({ id: 'ungrouped', files: rest })
    return chapters
    // the guide arrives as a fresh object each push; its head and chapter ids are what change
  }, [files, signature, mode])
}

/** useChapterBand publishes each chapter summary's height, for the sticky offsets below it. */
function useChapterBand(scroller: React.RefObject<HTMLDivElement | null>, chapters: Chapter[]): void {
  const signature = chapters.map(chapter => chapter.id).join('|')

  useLayoutEffect(() => {
    const summaries = scroller.current?.querySelectorAll<HTMLElement>('.gr-chapter-summary') ?? []
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        publishBand(entry.target as HTMLElement)
      }
    })
    for (const summary of summaries) {
      publishBand(summary)
      observer.observe(summary)
    }
    return () => observer.disconnect()
  }, [scroller, signature])
}

/** publishBand records a summary's height on its chapter; only the one-column layout reads it. */
function publishBand(summary: HTMLElement): void {
  summary.parentElement?.style.setProperty('--gr-chapter-band', `${summary.offsetHeight}px`)
}

/** useScrollAnchor keeps the file under the reader pinned when the guide reorders the pane. */
function useScrollAnchor(scroller: React.RefObject<HTMLDivElement | null>, chapters: Chapter[]): void {
  const signature = chapters.flatMap(chapter => chapter.files.map(pathOf)).join('|')
  const previous = useRef(signature)
  const anchor = useRef<{ id: string; offset: number } | null>(null)

  if (previous.current !== signature && scroller.current && anchor.current === null) {
    anchor.current = topVisibleFile(scroller.current)
  }

  useLayoutEffect(() => {
    if (previous.current === signature) {
      return
    }
    previous.current = signature
    const held = anchor.current
    anchor.current = null
    if (!held || !scroller.current) {
      return
    }
    const element = document.getElementById(held.id)
    if (element) {
      scroller.current.scrollTop = element.offsetTop - held.offset
    }
  }, [signature, scroller])
}

/** topVisibleFile records which file section is at the top of the viewport, and its offset. */
function topVisibleFile(scroller: HTMLDivElement): { id: string; offset: number } | null {
  for (const section of Array.from(scroller.querySelectorAll<HTMLElement>('.gr-file'))) {
    const offset = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    if (offset + section.offsetHeight > 0) {
      return { id: section.id, offset }
    }
  }
  return null
}

/** threadsForPath selects the threads anchored to one file. */
function threadsForPath(threads: readonly Thread[], path: string): Thread[] {
  return threads.filter(thread => thread.anchor.kind === 'line' && thread.anchor.path === path)
}

/** Chapter is one guide section with the files it covers, or the ungrouped remainder. */
interface Chapter {
  id: string
  group?: GuideGroup
  files: FileData[]
}

/** Mode is which of the two views the reviewer has selected. */
type Mode = 'guided' | 'diff'
