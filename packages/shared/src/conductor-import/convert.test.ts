import { describe, expect, test } from 'bun:test'
import { convertConductorExport, type ConductorRawExport } from './convert'

export function fixture(): ConductorRawExport {
  return {
    preview: { id: 'source-chat-1', title: 'Preserved title', createdAt: 1000, updatedAt: 5000, repositoryId: 'repo-1', repositoryName: 'app', repository: 'team/app', workspaceId: 'workspace-1', archived: true, hidden: false, partial: false },
    messages: [
      { id: 'm1', role: 'user', content: 'Fix the test', created_at: '2026-10-26T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: JSON.stringify({ type: 'assistant', session_id: 'old-vendor-id', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the test' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'test.ts' } }] } }), created_at: '2026-10-26T10:00:01Z', turn_id: 'turn-1' },
      { id: 'm3', role: 'user', content: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file content' }] } }), created_at: '2026-10-26T10:00:02Z' },
    ],
    events: [{ event_id: 'event1', event_type: 'sdk', content: '{"type":"original-event"}' }], attachments: [], warnings: [],
  }
}
describe('Conductor transcript conversion', () => {
  test('preserves role, text, tool/result linkage, title, timestamps and archive state with a fresh SDK', () => {
    const result = convertConductorExport(fixture())
    const { header, messages } = result.bundle.session
    expect(messages.map(m => m.type)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[2]).toMatchObject({ toolName: 'Read', toolUseId: 't1', toolInput: { file: 'test.ts' }, toolResult: 'file content', toolStatus: 'completed', turnId: 'turn-1' })
    expect(header).toMatchObject({ name: 'Preserved title', createdAt: 1000, lastUsedAt: 5000, isArchived: true, permissionMode: 'allow-all' })
    expect(header.sdkSessionId).toBeUndefined(); expect(header.sdkCwd).toBeUndefined(); expect(header.workingDirectory).toBeUndefined()
    expect(header.transferredSessionSummary).toContain('Fix the test')
    const original = JSON.parse(Buffer.from(result.bundle.files[0]!.contentBase64, 'base64').toString())
    expect(original.events).toEqual(fixture().events)
  })
  test('stable fingerprint/id skips identical exports, changed source creates a new copy', () => {
    expect(convertConductorExport(fixture()).bundle.session.header.id).toBe(convertConductorExport(fixture()).bundle.session.header.id)
    const changed = fixture(); changed.messages[0]!.content += '!'
    expect(convertConductorExport(changed).bundle.session.header.id).not.toBe(convertConductorExport(fixture()).bundle.session.header.id)
  })
  test('attachment names cannot traverse and stored paths are portable', () => {
    const raw = fixture(); raw.attachments = [{ id: '../../bad', original_name: '../../escape.txt', session_message_id: 'm1', contentBase64: Buffer.from('hello').toString('base64'), size: 5 }]
    const result = convertConductorExport(raw)
    expect(result.bundle.files[1]!.relativePath).not.toContain('..')
    expect(result.bundle.session.messages[0]!.attachments?.[0]?.storedPath).toStartWith('{{SESSION_PATH}}/attachments/')
  })
  test('cloud cache is explicitly partial; event-only cache is never claimed complete', () => {
    const raw = fixture(); raw.preview.partial = true
    expect(convertConductorExport(raw).origin.partial).toBe(true)
    raw.messages = []
    expect(convertConductorExport(raw).warnings.join(' ')).toContain('no complete conversation')
  })
  test('SDK initialization/results stay in the archive without exposing raw runtime metadata in chat', () => {
    const raw = fixture(); raw.messages.unshift({ id: 'init', role: 'assistant', content: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'old', cwd: '/Users/old', mcp_servers: [] }) })
    raw.messages.push({ id: 'end', role: 'assistant', content: JSON.stringify({ type: 'result', session_id: 'old', result: 'Already displayed' }) })
    const result = convertConductorExport(raw)
    expect(result.bundle.session.messages).toHaveLength(3)
    expect(result.bundle.session.header.transferredSessionSummary).not.toContain('/Users/old')
    expect(Buffer.from(result.bundle.files[0]!.contentBase64, 'base64').toString()).toContain('/Users/old')
  })
  test('ordinary user JSON stays user text; unknown SDK blocks remain in the original', () => {
    const raw = fixture(); raw.messages = [{ id: '1', role: 'user', content: '{"a":1}' }, { id: '2', role: 'assistant', content: '{"type":"assistant","message":{"role":"assistant","content":[{"type":"image","data":"placeholder"}]}}' }]
    const result = convertConductorExport(raw)
    expect(result.bundle.session.messages[0]!.content).toBe('{"a":1}')
    expect(result.warnings.join(' ')).toContain('unsupported')
  })
})
