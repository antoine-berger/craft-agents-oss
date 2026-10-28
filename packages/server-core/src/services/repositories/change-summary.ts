import type { SessionChangeSummary } from '@craft-agent/shared/sessions'
import { runGitResult } from '../git'

/** NUL framing prevents renamed files and paths containing tabs from becoming extra statistics. */
export function parseChangeNumstat(text: string): Pick<SessionChangeSummary, 'additions' | 'deletions' | 'files' | 'binaryFiles'> | undefined {
  const fields = text.split('\0')
  const result = { additions: 0, deletions: 0, files: 0, binaryFiles: 0 }
  for (let index = 0; index < fields.length;) {
    const field = fields[index++]!
    if (!field) continue
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field)
    if (!match) return
    if (!match[3]) {
      if (!fields[index] || !fields[index + 1]) return
      index += 2
    }
    result.files++
    if (match[1] === '-' || match[2] === '-') result.binaryFiles++
    else {
      result.additions += Number(match[1])
      result.deletions += Number(match[2])
    }
  }
  return result
}

/** Cached on turn completion only. Untracked/ignored files are deliberately outside this count. */
export async function readSessionChangeSummary(directory: string, baseCommit: string | undefined): Promise<SessionChangeSummary | undefined> {
  if (!baseCommit || !/^[a-f\d]{40,64}$/i.test(baseCommit)) return
  const diff = await runGitResult(directory, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--find-renames', baseCommit, '--'])
  if (!diff.ok) return
  const summary = parseChangeNumstat(diff.stdout)
  return summary ? { ...summary, baseCommit, observedAt: Date.now(), scope: 'tracked' } : undefined
}
