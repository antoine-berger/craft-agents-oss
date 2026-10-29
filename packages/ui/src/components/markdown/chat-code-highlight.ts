import hljs from 'highlight.js'

/** The installed Conductor uses the same engine, aliases and 100k-character bound. */
export function highlightChatCode(code: string, language: string): string | undefined {
  if (code.length > 100_000 || !hljs.getLanguage(language)) return undefined
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return undefined
  }
}
