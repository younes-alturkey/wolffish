import { parseUnifiedDiff } from '@/components/chat/DiffView'

/**
 * The diff parser behind the red/green block: the patch text on a tool
 * result's meta is the only input, so the numbering and the line kinds have
 * to come out the same every time it is rendered.
 */
describe('parseUnifiedDiff', () => {
  const patch = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,3 +3,4 @@',
    ' keep',
    '-old',
    '+new',
    '+added',
    '',
    ' tail'
  ].join('\n')

  it('drops the file headers and numbers both sides from the hunk', () => {
    const lines = parseUnifiedDiff(patch)
    expect(lines.map((line) => line.kind)).toEqual([
      'hunk',
      'ctx',
      'del',
      'add',
      'add',
      'ctx',
      'ctx'
    ])
    expect(lines[1]).toEqual({ kind: 'ctx', text: 'keep', oldNo: 3, newNo: 3 })
    expect(lines[2]).toEqual({ kind: 'del', text: 'old', oldNo: 4 })
    expect(lines[3]).toEqual({ kind: 'add', text: 'new', newNo: 4 })
    expect(lines[4]).toEqual({ kind: 'add', text: 'added', newNo: 5 })
    // The bare empty line inside the hunk is an empty context line.
    expect(lines[5]).toEqual({ kind: 'ctx', text: '', oldNo: 5, newNo: 6 })
    expect(lines[6]).toEqual({ kind: 'ctx', text: 'tail', oldNo: 6, newNo: 7 })
  })

  it('returns nothing for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})
