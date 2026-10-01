import { describe, it, expect } from 'vitest'
import { GuideGenerator, buildDescribePrompt, buildGroupPrompt, describeBatches, diffForFiles, parseDescriptions, parseGuideResponse, repairGroups } from './guide.js'
import type { ChangedFile } from './types.js'

const file = (path: string): ChangedFile => ({
  path,
  status: 'modified',
  oldBlob: 'a',
  newBlob: 'b',
  additions: 1,
  deletions: 1,
  binary: false,
})

describe('diffForFiles', () => {
  it('returns a headerless diff unchanged', () => {
    expect(diffForFiles('not a patch', ['a.ts'])).toBe('not a patch')
  })

  it('reads a quoted new path', () => {
    const diff = 'diff --git "a/my file.ts" "b/my file.ts"\n+line\n'
    expect(diffForFiles(diff, ['my file.ts'])).toBe(diff)
  })
})

describe('parseGuideResponse', () => {
  it('reads groups out of the Claude Code json envelope', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: '{"groups":[{"title":"Core","summary":"s","files":["a.ts"]}]}',
    })
    expect(parseGuideResponse(envelope)?.[0]?.title).toBe('Core')
  })

  it('tolerates a fenced code block around the json', () => {
    const envelope = JSON.stringify({
      result: '```json\n{"groups":[{"title":"Core","summary":"s","files":["a.ts"]}]}\n```',
    })
    expect(parseGuideResponse(envelope)?.[0]?.files).toEqual(['a.ts'])
  })

  it('tolerates prose surrounding the json', () => {
    const envelope = JSON.stringify({
      result: 'Here you go:\n{"groups":[{"title":"C","summary":"s","files":["a.ts"]}]}\nHope that helps.',
    })
    expect(parseGuideResponse(envelope)?.[0]?.title).toBe('C')
  })

  it('accepts a bare json payload with no envelope', () => {
    expect(parseGuideResponse('{"groups":[{"title":"C","summary":"s","files":[]}]}')?.length).toBe(1)
  })

  it('skips prose braces and takes the grouping', () => {
    const raw = 'Ideas: {a} and a shape like {"groups":[{"title":"echo"}]} — final answer:\n{"groups":[{"title":"C","summary":"s","files":["a.ts"]}]}'
    expect(parseGuideResponse(raw)?.[0]?.title).toBe('C')
  })

  it('returns null when there is no json at all', () => {
    expect(parseGuideResponse('total failure')).toBeNull()
  })
})

describe('repairGroups', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts']

  it('keeps a well-formed grouping untouched', () => {
    const groups = repairGroups(
      [
        { title: 'Core', summary: 's1', files: ['a.ts', 'b.ts'] },
        { title: 'Glue', summary: 's2', files: ['c.ts'] },
      ],
      paths,
    )
    expect(groups.map(g => g.title)).toEqual(['Core', 'Glue'])
    expect(groups.some(g => g.repaired)).toBe(false)
  })

  it('drops paths the model invented', () => {
    const groups = repairGroups([{ title: 'Core', summary: 's', files: ['a.ts', 'ghost.ts'] }], ['a.ts'])
    expect(groups[0]?.files).toEqual(['a.ts'])
  })

  it('sweeps unassigned files into a visible trailing group', () => {
    const groups = repairGroups([{ title: 'Core', summary: 's', files: ['a.ts'] }], paths)
    const last = groups[groups.length - 1]
    expect(last?.title).toBe('Other changes')
    expect(last?.repaired).toBe(true)
    expect(last?.files).toEqual(['b.ts', 'c.ts'])
  })

  it('assigns a duplicated file to its first group only', () => {
    const groups = repairGroups(
      [
        { title: 'One', summary: 's', files: ['a.ts'] },
        { title: 'Two', summary: 's', files: ['a.ts', 'b.ts'] },
      ],
      ['a.ts', 'b.ts'],
    )
    expect(groups[0]?.files).toEqual(['a.ts'])
    expect(groups[1]?.files).toEqual(['b.ts'])
  })

  it('guarantees every changed file appears exactly once', () => {
    const groups = repairGroups(
      [
        { title: 'One', summary: 's', files: ['a.ts', 'a.ts'] },
        { title: 'Two', summary: 's', files: ['ghost.ts'] },
      ],
      paths,
    )
    const assigned = groups.flatMap(g => g.files)
    expect(assigned.slice().sort()).toEqual(paths.slice().sort())
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('drops groups left empty after repair', () => {
    const groups = repairGroups([{ title: 'Ghosts', summary: 's', files: ['ghost.ts'] }], ['a.ts'])
    expect(groups.map(g => g.title)).toEqual(['Other changes'])
  })

  it('keeps the reading order the model chose', () => {
    const groups = repairGroups(
      [
        { title: 'Glue', summary: 's', files: ['c.ts'] },
        { title: 'Fallout', summary: 's', files: ['b.ts'] },
        { title: 'Core', summary: 's', files: ['a.ts'] },
      ],
      paths,
    )
    expect(groups.map(g => g.title)).toEqual(['Glue', 'Fallout', 'Core'])
  })

  it('gives every group a stable unique id', () => {
    const groups = repairGroups(
      [
        { title: 'One', summary: 's', files: ['a.ts'] },
        { title: 'Two', summary: 's', files: ['b.ts'] },
      ],
      ['a.ts', 'b.ts'],
    )
    expect(new Set(groups.map(g => g.id)).size).toBe(2)
  })
})

describe('buildDescribePrompt', () => {
  it('lists every changed file with its line counts', () => {
    const prompt = buildDescribePrompt([file('a.ts'), file('b.ts')])
    expect(prompt).toContain('a.ts')
    expect(prompt).toContain('b.ts')
  })
})

describe('buildGroupPrompt', () => {
  it('hands over the descriptions and no diff', () => {
    const prompt = buildGroupPrompt([{ path: 'a.ts', does: 'adds the parser' }])
    expect(prompt).toContain('a.ts: adds the parser')
  })
})

describe('parseDescriptions', () => {
  it('keeps one note per changed path', () => {
    const raw = JSON.stringify({ result: '{"files":[{"path":"a.ts","does":"adds the parser"}]}' })
    expect(parseDescriptions(raw, ['a.ts'])).toEqual([{ path: 'a.ts', does: 'adds the parser' }])
  })

  it('drops invented paths and still carries a skipped file forward', () => {
    const raw = JSON.stringify({ result: '{"files":[{"path":"ghost.ts","does":"x"}]}' })
    expect(parseDescriptions(raw, ['a.ts'])).toEqual([{ path: 'a.ts', does: 'no description' }])
  })
})

describe('GuideGenerator', () => {
  /** twoPass answers every description batch from the paths, then the grouping pass verbatim. */
  const twoPass = (grouping: string, paths: readonly string[] = ['a.ts']) => {
    return {
      run: async (prompt: string) => {
        if (prompt.startsWith('Describe')) {
          return JSON.stringify({ result: JSON.stringify({ files: paths.map(path => ({ path, does: 'does something' })) }) })
        }
        return grouping
      },
    }
  }

  it('returns repaired groups from the runner output', async () => {
    const runner = twoPass(JSON.stringify({ result: '{"groups":[{"title":"Core","summary":"s","files":["a.ts"]}]}' }))
    const groups = await new GuideGenerator(runner).generate([file('a.ts')], 'diff text')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.title).toBe('Core')
  })

  it('surfaces an unparseable grouping as an error rather than an empty guide', async () => {
    const runner = twoPass('not json')
    await expect(new GuideGenerator(runner).generate([file('a.ts')], 'diff')).rejects.toThrow(/could not be parsed/i)
  })

  it('fails when the description pass returns nothing usable', async () => {
    const runner = { run: async () => 'not json' }
    await expect(new GuideGenerator(runner).generate([], 'diff')).rejects.toThrow(/could not describe/i)
  })

  it('fails rather than returning a guide that classified nothing', async () => {
    const runner = twoPass(JSON.stringify({ result: '{"groups":[]}' }))
    await expect(new GuideGenerator(runner).generate([file('a.ts')], 'diff')).rejects.toThrow(/assigned no files/i)
  })

  it('fails when every path the model returned was invented', async () => {
    const runner = twoPass(JSON.stringify({ result: '{"groups":[{"title":"C","summary":"s","files":["ghost.ts"]}]}' }))
    await expect(new GuideGenerator(runner).generate([file('a.ts')], 'diff')).rejects.toThrow(/assigned no files/i)
  })

  it('accepts a partial grouping, sweeping only the remainder', async () => {
    const runner = twoPass(JSON.stringify({ result: '{"groups":[{"title":"C","summary":"s","files":["a.ts"]}]}' }), ['a.ts', 'b.ts'])
    const groups = await new GuideGenerator(runner).generate([file('a.ts'), file('b.ts')], 'diff')
    expect(groups.map(g => g.title)).toEqual(['C', 'Other changes'])
  })

  it('propagates a runner failure unchanged', async () => {
    const runner = {
      run: async () => {
        throw new Error('claude not found')
      },
    }
    await expect(new GuideGenerator(runner).generate([file('a.ts')], 'diff')).rejects.toThrow('claude not found')
  })

  it('sends the whole diff to the description pass without truncation', async () => {
    const diff = 'x'.repeat(500_000)
    let received = ''
    let call = 0
    const runner = {
      run: async (_prompt: string, stdin: string) => {
        call += 1
        if (call === 1) {
          received = stdin
          return JSON.stringify({ result: '{"files":[{"path":"a.ts","does":"d"}]}' })
        }
        return JSON.stringify({ result: '{"groups":[{"title":"C","summary":"s","files":["a.ts"]}]}' })
      },
    }
    await new GuideGenerator(runner).generate([file('a.ts')], diff)
    expect(received).toContain(diff)
  })

  it('describes files in parallel batches of at most eight, and only sends each batch its own patch', async () => {
    const files = Array.from({ length: 10 }, (_, index) => file(`f${index}.ts`))
    const diff = files.map(entry => `diff --git a/${entry.path} b/${entry.path}\n--- a/${entry.path}\n+++ b/${entry.path}\n@@ -1 +1 @@\n-old\n+${entry.path}\n`).join('')
    let inFlight = 0
    let maxInFlight = 0
    const describeStdins: string[] = []
    const runner = {
      run: async (prompt: string, stdin: string) => {
        if (!prompt.startsWith('Describe')) {
          return JSON.stringify({ result: '{"groups":[{"title":"C","summary":"s","files":["f0.ts"]}]}' })
        }
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
        describeStdins.push(stdin)
        const paths = [...prompt.matchAll(/^- (f\d+\.ts) /gm)].map(match => match[1] ?? '')
        return JSON.stringify({ result: JSON.stringify({ files: paths.map(path => ({ path, does: 'does something' })) }) })
      },
    }

    await new GuideGenerator(runner).generate(files, diff)

    expect(describeBatches(files)).toHaveLength(8)
    expect(describeBatches(files).map(batch => batch.length)).toEqual([2, 2, 1, 1, 1, 1, 1, 1])
    expect(maxInFlight).toBe(8)
    expect(describeStdins).toHaveLength(8)
    const first = describeStdins.find(stdin => stdin.includes('diff --git a/f0.ts'))
    expect(first).toContain('diff --git a/f1.ts')
    expect(first).not.toContain('diff --git a/f2.ts')
    const last = describeStdins.find(stdin => stdin.includes('diff --git a/f9.ts'))
    expect(last).not.toContain('diff --git a/f0.ts')
  })

  it('keeps the diff out of the grouping pass', async () => {
    const stdins: string[] = []
    const runner = {
      run: async (_prompt: string, stdin: string) => {
        stdins.push(stdin)
        return stdins.length === 1
          ? JSON.stringify({ result: '{"files":[{"path":"a.ts","does":"d"}]}' })
          : JSON.stringify({ result: '{"groups":[{"title":"C","summary":"s","files":["a.ts"]}]}' })
      },
    }
    await new GuideGenerator(runner).generate([file('a.ts')], 'the whole diff')
    expect(stdins[1]).toBe('')
  })
})
