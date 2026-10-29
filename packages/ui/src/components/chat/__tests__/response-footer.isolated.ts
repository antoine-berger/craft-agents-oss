import { expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '../../tooltip'
import { ResponseFooter } from '../turn/ResponseFooter'

const render = (extra: object = {}) => renderToStaticMarkup(React.createElement(TooltipProvider, null,
  React.createElement(ResponseFooter, { copied: false, onCopy() {}, variant: 'answer', appearance: 'chat', timestamp: 1000, ...extra })))

it('does not manufacture a usage popup or percentages for historical responses', () => {
  expect(render()).not.toContain('Response details')
  expect(render()).not.toContain('%')
})

it('exposes measured details and real changed-file navigation in chat only', () => {
  const html = render({ usage: { model: 'provider-model', outputTokens: 5 }, changedFiles: ['/repo/src/app.ts'], onOpenFile() {} })
  expect(html).toContain('Response details')
  expect(html).toContain('title="/repo/src/app.ts"')
  expect(html).toContain('app.ts')
  expect(render({ appearance: 'default', usage: { outputTokens: 5 }, changedFiles: ['/repo/app.ts'] })).not.toContain('Response details')
})

it('does not mount thousands of changed-file buttons for a codemod response', () => {
  const paths = Array.from({ length: 1900 }, (_, index) => `/repo/file-${index}.ts`)
  const html = render({ changedFiles: paths, onOpenFile() {} })
  expect(html).toContain('file-0.ts')
  expect(html).toContain('file-1.ts')
  expect(html).not.toContain('title="/repo/file-2.ts"')
  expect(html).toContain('+1898 more')
  expect(html).toContain('Show 3 more changed files')
})
