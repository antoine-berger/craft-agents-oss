import { afterAll, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { WorktreeDirectory, WorktreeFilesAPI } from '../../../../../../packages/shared/src/protocol/worktree-files'

mock.module('@craft-agent/ui', () => ({
  ShikiCodeViewer: ({ code }: { code: string }) => React.createElement('pre', null, code),
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}))
const originalDocument = globalThis.document
Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { classList: { contains: () => false } } } })
afterAll(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument }) })
const { WorktreeFilesPanel } = await import('./WorktreeFilesPanel')
const directory = (name: string): WorktreeDirectory => ({ rootName: 'repo', path: '', entries: [{ name, path: name, kind: 'file' }], truncated: false })
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test('late directory responses cannot display files from the previously selected session', async () => {
  let resolveA!: (value: WorktreeDirectory) => void
  const api = { getWorktreeFiles: (id: string) => id === 'A' ? new Promise<WorktreeDirectory>(resolve => { resolveA = resolve }) : Promise.resolve(directory('B.ts')) } as WorktreeFilesAPI
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(WorktreeFilesPanel, { sessionId: 'A', api })); await tick() })
  await act(async () => { renderer.update(React.createElement(WorktreeFilesPanel, { sessionId: 'B', api })); await tick() })
  await act(async () => { resolveA(directory('A.ts')); await tick() })
  const text = JSON.stringify(renderer.toJSON())
  expect(text).toContain('B.ts'); expect(text).not.toContain('A.ts')
  act(() => renderer.unmount())
})

test('a save conflict retains the draft, including after closing and reopening the panel', async () => {
  const api: WorktreeFilesAPI = {
    getWorktreeFiles: async () => directory('app.ts'),
    readWorktreeFile: async () => ({ path: 'app.ts', content: 'original', version: 'a'.repeat(64), modifiedAt: 1 }),
    writeWorktreeFile: async () => { throw new Error('File changed. Reload before saving.') },
  }
  let renderer!: ReactTestRenderer
  const element = () => React.createElement(WorktreeFilesPanel, { sessionId: 'draft-session', api, initialPath: 'app.ts' })
  await act(async () => { renderer = create(element()); await tick() })
  act(() => renderer.root.findAllByType('button').find(button => button.children.includes('Edit'))!.props.onClick())
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'human draft' } }))
  await act(async () => { renderer.root.findAllByType('button').find(button => button.children.includes('Save'))!.props.onClick(); await tick() })
  expect(renderer.root.findByType('textarea').props.value).toBe('human draft')
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('File changed')
  act(() => renderer.unmount())
  await act(async () => { renderer = create(element()); await tick() })
  expect(renderer.root.findByType('textarea').props.value).toBe('human draft')
  act(() => renderer.root.findByProps({ 'aria-label': 'Discard file edits' }).props.onClick())
  act(() => renderer.unmount())
})

test('finishing a save for A cannot replace B after navigation within the same session', async () => {
  let finish!: (file: { path: string; content: string; version: string; modifiedAt: number }) => void
  const contents = new Map([['A.ts', 'A.ts'], ['B.ts', 'B.ts']])
  const api: WorktreeFilesAPI = {
    getWorktreeFiles: async () => directory('A.ts'),
    readWorktreeFile: async (_session, path) => ({ path, content: contents.get(path)!, version: 'a'.repeat(64), modifiedAt: 1 }),
    writeWorktreeFile: async (_session, input) => new Promise(resolve => { finish = file => { contents.set(input.path, file.content); resolve(file) } }),
  }
  let renderer!: ReactTestRenderer
  const element = (path: string) => React.createElement(WorktreeFilesPanel, { sessionId: 'same-session-navigation', api, initialPath: path })
  await act(async () => { renderer = create(element('A.ts')); await tick() })
  act(() => renderer.root.findAllByType('button').find(button => button.children.includes('Edit'))!.props.onClick())
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'edited A' } }))
  await act(async () => { renderer.root.findAllByType('button').find(button => button.children.includes('Save'))!.props.onClick(); await tick() })
  await act(async () => { renderer.update(element('B.ts')); await tick() })
  await act(async () => { finish({ path: 'A.ts', content: 'edited A', version: 'b'.repeat(64), modifiedAt: 2 }); await tick() })
  expect(renderer.root.findByType('pre').children).toEqual(['B.ts'])
  expect(renderer.root.findByProps({ 'aria-label': 'Open worktree file by path' }).props.value).toBe('B.ts')
  await act(async () => { renderer.update(element('A.ts')); await tick() })
  expect(renderer.root.findByType('pre').children).toEqual(['edited A'])
  expect(renderer.root.findAllByType('textarea')).toHaveLength(0)
  act(() => renderer.unmount())
})

test('ordinary textarea edits retain the source file CRLF and CR line endings', async () => {
  for (const eol of ['\r\n', '\r']) {
    let saved = ''
    const api: WorktreeFilesAPI = {
      getWorktreeFiles: async () => directory('eol.ts'),
      readWorktreeFile: async () => ({ path: 'eol.ts', content: `a${eol}b${eol}`, version: 'a'.repeat(64), modifiedAt: 1 }),
      writeWorktreeFile: async (_session, input) => { saved = input.content; return { path: input.path, content: saved, version: 'b'.repeat(64), modifiedAt: 2 } },
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(WorktreeFilesPanel, { sessionId: `eol-${eol.length}`, api, initialPath: 'eol.ts' })); await tick() })
    act(() => renderer.root.findAllByType('button').find(button => button.children.includes('Edit'))!.props.onClick())
    act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'a\nb!\n' } }))
    await act(async () => { renderer.root.findAllByType('button').find(button => button.children.includes('Save'))!.props.onClick(); await tick() })
    expect(saved).toBe(`a${eol}b!${eol}`)
    act(() => renderer.unmount())
  }
})

test('mixed line endings remain preview-only instead of being silently normalized', async () => {
  let writes = 0
  const api: WorktreeFilesAPI = {
    getWorktreeFiles: async () => directory('mixed.ts'),
    readWorktreeFile: async () => ({ path: 'mixed.ts', content: 'a\r\nb\nc\r', version: 'a'.repeat(64), modifiedAt: 1 }),
    writeWorktreeFile: async () => { writes++; throw new Error('Unexpected save') },
  }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(WorktreeFilesPanel, { sessionId: 'mixed-line-endings', api, initialPath: 'mixed.ts' })); await tick() })
  expect(renderer.root.findAllByType('button').find(button => button.children.includes('Edit'))!.props.disabled).toBe(true)
  expect(JSON.stringify(renderer.toJSON())).toContain('Mixed line endings: preview only')
  expect(renderer.root.findByType('pre').children).toEqual(['a\r\nb\nc\r'])
  expect(writes).toBe(0)
  act(() => renderer.unmount())
})
