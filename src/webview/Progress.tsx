/** Progress is VS Code's thin running bar; it stays invisible for the first moments, so a quick answer never flashes it. */
export const Progress = ({ label }: { label: string }) => <div className="gr-progress" role="progressbar" aria-label={label} />
