import * as React from 'react'
import { ArrowUpRight } from 'lucide-react'
import { defaultUrlTransform } from 'react-markdown'
import { detectLinks } from '../markdown/linkify'

/** A sent prompt keeps its literal text; only URLs and file paths become interactive. */
export function PlainMessageText({
  children,
  onUrlClick,
  onFileClick,
}: {
  children: string
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}) {
  const parts: React.ReactNode[] = []
  let end = 0
  for (const link of detectLinks(children)) {
    if (link.start < end) continue
    parts.push(children.slice(end, link.start))
    const safeHref = link.type === 'file' ? undefined : defaultUrlTransform(link.url) || undefined
    parts.push(
      <a
        key={link.start}
        href={safeHref}
        role={link.type === 'file' && onFileClick ? 'button' : undefined}
        tabIndex={link.type === 'file' && onFileClick ? 0 : undefined}
        className="cursor-pointer [font-weight:inherit] text-[var(--accent-text)] no-underline hover:underline wrap-anywhere"
        onKeyDown={event => {
          if (link.type === 'file' && onFileClick && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            onFileClick(link.url)
          }
        }}
        onClick={event => {
          if (link.type === 'file' && onFileClick) {
            event.preventDefault()
            onFileClick(link.url)
          } else if (link.type !== 'file' && safeHref && onUrlClick) {
            event.preventDefault()
            onUrlClick(link.url)
          }
        }}
      >
        {link.text}
        {link.type !== 'file' && safeHref && <ArrowUpRight aria-hidden className="ml-1 inline size-3 align-[-0.125em]" />}
      </a>
    )
    end = link.end
  }
  parts.push(children.slice(end))
  return <span className="whitespace-pre-wrap wrap-anywhere">{parts}</span>
}
