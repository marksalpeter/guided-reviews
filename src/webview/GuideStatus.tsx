import type { ChangedFile, ReviewState } from '../core/types.js'
import { post } from './vscodeApi.js'

/** GuideStatus floats over the bottom of the left column while the guide is absent or stale. */
export const GuideStatus = ({
  state,
  busy,
  files,
}: {
  state: ReviewState
  busy: boolean
  files: readonly ChangedFile[]
}) => {
  if (busy) {
    return (
      <Pill>
        <Spinner />
        <span className="gr-pill-label">Generating guide…</span>
        <DiffStat files={files} />
      </Pill>
    )
  }
  if (state.guideError) {
    return (
      <Pill>
        <span className="gr-pill-label error">{state.guideError}</span>
        <button className="secondary" onClick={() => post({ type: 'generateGuide' })}>
          Retry
        </button>
      </Pill>
    )
  }
  if (!state.guide) {
    return (
      <Pill>
        <DiffStat files={files} />
        <button onClick={() => post({ type: 'generateGuide' })}>Generate guide</button>
      </Pill>
    )
  }
  if (state.guideStale) {
    return (
      <Pill>
        <span className="gr-pill-label">Guide describes an earlier commit</span>
        <button className="secondary" onClick={() => post({ type: 'generateGuide' })}>
          Regenerate
        </button>
      </Pill>
    )
  }
  return null
}

/** Spinner is the ring the guide turns while it writes: one still track, one arc over it.
    Both are strokes on the same radius, so the arc can never sit off the track. */
const Spinner = () => (
  <svg className="gr-spinner" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle className="gr-spinner-track" cx="8" cy="8" r="6.5" />
    <path className="gr-spinner-arc" d="M8 1.5 A 6.5 6.5 0 0 1 14.5 8" />
  </svg>
)

/** Pill is the floating container anchored to the bottom of the left column. */
const Pill = ({ children }: { children: React.ReactNode }) => <div className="gr-pill">{children}</div>

/** DiffStat summarises the whole review the way the file cards summarise one file. */
const DiffStat = ({ files }: { files: readonly ChangedFile[] }) => {
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  return (
    <span className="gr-pill-stat">
      {files.length} {files.length === 1 ? 'file' : 'files'} changed
      <span className="gr-stat-add">+{additions}</span>
      <span className="gr-stat-del">−{deletions}</span>
    </span>
  )
}
