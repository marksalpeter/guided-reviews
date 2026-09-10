import type { ChangedFile } from '../core/types.js'

/** FileList is the stacked list of changed files in the left column. */
export const FileList = ({
  paths,
  files,
  reviewedBlobs,
  onSelect,
}: {
  paths: readonly string[]
  files: readonly ChangedFile[]
  reviewedBlobs: Record<string, string>
  onSelect: (path: string) => void
}) => (
  <div className="gr-filelist">
    {paths.map(path => {
      const meta = files.find(file => file.path === path)
      const dir = dirname(path)
      return (
        <button
          key={path}
          className={`gr-filecard${isReviewed(reviewedBlobs[path], meta?.newBlob) ? ' reviewed' : ''}`}
          title={path}
          onClick={() => onSelect(path)}
        >
          <FileGlyph />
          <span className="gr-filecard-path">
            {dir && <span className="gr-filecard-dir">{dir}/</span>}
            <span className="gr-filecard-name">{basename(path)}</span>
          </span>
          <span className="gr-spacer" />
          {meta && meta.additions > 0 && <span className="gr-stat-add">+{meta.additions}</span>}
          {meta && meta.deletions > 0 && <span className="gr-stat-del">−{meta.deletions}</span>}
        </button>
      )
    })}
  </div>
)

/** reviewedCount reports how many of these paths are ticked off against their current blob. */
export function reviewedCount(paths: readonly string[], files: readonly ChangedFile[], reviewedBlobs: Record<string, string>): number {
  return paths.filter(path => isReviewed(reviewedBlobs[path], files.find(file => file.path === path)?.newBlob)).length
}

/** isReviewed reports whether the tick was made against the blob currently on screen. */
export function isReviewed(markedBlob: string | undefined, currentBlob: string | null | undefined): boolean {
  return markedBlob !== undefined && markedBlob === (currentBlob ?? '')
}

/** FileGlyph is the document icon each card leads with. */
const FileGlyph = () => (
  <svg className="gr-filecard-icon" width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
    <path
      d="M1 1h6l4 4v8H1z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path d="M7 1v4h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
)

/** basename is the file's own name. */
function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** dirname is the directory a file sits in, empty at the repository root. */
function dirname(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}
