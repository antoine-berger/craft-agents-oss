import { describe, expect, it } from 'bun:test'
import type { ActivityItem, ResponseContent } from '../TurnCard'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import { buildTurnPresentation, getAssistantSearchText } from '../turn/turn-presentation'

function tool(id: string, sourceMessageId = id, toolName = 'Read'): ActivityItem {
  return { id, sourceMessageId, type: 'tool', status: 'completed', toolName, toolUseId: `tool:${id}`, timestamp: Number(id.replace(/\D/g, '')) || 1 }
}
function text(id: string, sourceMessageId = id, content = id): ActivityItem {
  return { ...tool(id, sourceMessageId), type: 'intermediate', toolName: undefined, toolUseId: undefined, content, messageId: id }
}
function response(messageId = 'answer', sourceMessageId = messageId): ResponseContent {
  return { messageId, sourceMessageId, text: 'Final answer', isStreaming: false }
}

function visibleIds(sections: ReturnType<typeof buildTurnPresentation>): string[] {
  return sections.flatMap(section => {
    const messages = section.kind === 'message' ? [section.message] : section.messages
    return messages.flatMap(message => message.items.flatMap(item => item.kind === 'response'
      ? [item.response.messageId!]
      : item.kind === 'activity' ? [item.activity.id] : [item.group.parent.id, ...item.group.children.map(child => child.id)]))
  })
}

describe('chat transcript presentation', () => {
  it('keeps short work explicit and collapses at three source messages', () => {
    expect(buildTurnPresentation([tool('a1'), tool('a2')], response(), true).map(item => item.kind)).toEqual(['message', 'message', 'message'])
    const sections = buildTurnPresentation([tool('a1'), text('a2'), tool('a3')], response(), true)
    expect(sections.map(item => item.kind)).toEqual(['summary', 'message'])
    const summary = sections[0]!
    expect(summary.kind === 'summary' && summary.counts).toEqual({ tools: 2, messages: 1, subagents: 0, failed: 0 })
    expect(visibleIds(sections)).toEqual(['a1', 'a2', 'a3', 'answer'])
  })

  it('counts one SDK message holding several tools once for the collapse threshold', () => {
    const sections = buildTurnPresentation([tool('a1', 'sdk1'), tool('a2', 'sdk1'), tool('a3', 'sdk2')], response(), true)
    expect(sections.map(item => item.kind)).toEqual(['message', 'message', 'message'])
    const first = sections[0]!
    expect(first.kind === 'message' && first.message.items.length).toBe(2)
  })

  it('keeps live commentary and tools visible instead of folding the whole turn', () => {
    const activities = [text('a1', 'sdk1'), tool('a2'), text('a3'), tool('a4')]
    const sections = buildTurnPresentation(activities, response(), false)
    expect(sections.every(section => section.kind === 'message')).toBe(true)
    expect(visibleIds(sections)).toEqual(['a1', 'a2', 'a3', 'a4', 'answer'])
  })

  it('keeps the last commentary visible when a completed turn has no final response', () => {
    const sections = buildTurnPresentation([tool('a1'), tool('a2'), tool('a3'), text('a4')], undefined, true)
    expect(sections.map(item => item.kind)).toEqual(['summary', 'message'])
    expect(sections.at(-1)?.kind === 'message' && sections.at(-1)!.message.id).toBe('a4')
  })

  it('preserves question and plan boundaries instead of hiding them in an older summary', () => {
    const sections = buildTurnPresentation([tool('a1'), text('a2'), tool('a3'), tool('a4', 'a4', 'AskUserQuestion'), text('a5'), tool('a6', 'a6', 'mcp__session__SubmitPlan')], undefined, true)
    expect(sections.map(item => item.kind)).toEqual(['summary', 'message', 'message', 'message'])
    expect(visibleIds(sections)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
  })

  it('groups eligible same-source MCP runs but respects text and source boundaries', () => {
    const sections = buildTurnPresentation([
      tool('a1', 'a1', 'mcp__linear__list'), tool('a2', 'a2', 'mcp__linear__read'),
      text('a3'), tool('a4', 'a4', 'mcp__github__read'), tool('a5', 'a5', 'mcp__conductor__read'),
    ], response(), false)
    expect(sections.map(item => item.kind)).toEqual(['mcp', 'message', 'mcp', 'message', 'message'])
    expect(sections[0]?.kind === 'mcp' && sections[0].counts.tools).toBe(2)
    expect(visibleIds(sections)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'answer'])
  })

  it('does not source-group mixed text/tool content from one SDK message', () => {
    const sections = buildTurnPresentation([text('a1', 'sdk1'), tool('a2', 'sdk1', 'mcp__linear__read')], response(), false)
    expect(sections.map(item => item.kind)).toEqual(['message', 'message'])
  })

  it('does not present Craft session tools as an external connector', () => {
    const sections = buildTurnPresentation([
      tool('a1', 'sdk1', 'mcp__session__read_agent_chat'),
      tool('a2', 'sdk2', 'mcp__session__send_agent_message'),
      tool('a3', 'sdk3', 'mcp__linear__read'),
    ], response(), false)
    expect(sections.map(section => section.kind)).toEqual(['message', 'message', 'mcp', 'message'])
    expect(visibleIds(sections)).toEqual(['a1', 'a2', 'a3', 'answer'])
  })

  it('keeps subagent child transcripts with their parent and excludes children from root summary counts', () => {
    const parent = { ...tool('a1', 'sdk1', 'Agent'), toolInput: { description: 'Review', subagent_type: 'reviewer' } }
    const child = { ...text('a2', 'child1', 'Child answer'), parentId: parent.toolUseId }
    const sections = buildTurnPresentation([parent, child, tool('a3'), tool('a4')], response(), true)
    const first = sections[0]!
    expect(first.kind === 'summary' && first.counts).toEqual({ tools: 2, subagents: 1, messages: 0, failed: 0 })
    expect(visibleIds(sections)).toEqual(['a1', 'a2', 'a3', 'a4', 'answer'])
  })

  it('does not duplicate an intermediate message promoted to the final answer', () => {
    const activities = [tool('a1'), text('a2', 'sdk2', 'Retained text')]
    const sections = buildTurnPresentation(activities, { ...response('a2', 'sdk2'), text: 'Retained text' }, true)
    expect(visibleIds(sections)).toEqual(['a1', 'a2'])
    expect(activities).toHaveLength(2)
  })

  it('shows one proposal for a successful SubmitPlan without hiding failed or legacy calls', () => {
    const submit = tool('a1', 'sdk1', 'mcp__session__SubmitPlan')
    const plan = { ...text('a2', 'sdk2', '# Proposal'), type: 'plan' as const }
    expect(visibleIds(buildTurnPresentation([submit, plan], undefined, true))).toEqual(['a2'])
    expect(visibleIds(buildTurnPresentation([submit], undefined, true))).toEqual(['a1'])
    expect(visibleIds(buildTurnPresentation([{ ...submit, status: 'error' }, plan], undefined, true))).toEqual(['a1', 'a2'])
  })

  it('starts image-generation work summaries expanded', () => {
    const sections = buildTurnPresentation([tool('a1', 'a1', 'ImageGeneration'), tool('a2'), tool('a3')], response(), true)
    expect(sections[0]?.kind === 'summary' && sections[0].defaultExpanded).toBe(true)
  })
})

describe('message ownership before presentation', () => {
  it('keeps a child final answer inside its subagent and preserves its annotation identity', () => {
    const turns = groupMessagesByTurn([
      { id: 'u', role: 'user', content: 'Review', timestamp: 1 },
      { id: 'parent', role: 'tool', content: '', timestamp: 2, toolName: 'Agent', toolUseId: 'agent1', toolStatus: 'completed', turnId: 'sdk1' },
      { id: 'child', role: 'assistant', content: 'Child answer', timestamp: 3, parentToolUseId: 'agent1', turnId: 'sdk-child' },
      { id: 'answer', role: 'assistant', content: 'Owner answer', timestamp: 4, turnId: 'sdk2' },
    ], { isSessionProcessing: false })
    const assistant = turns.filter(turn => turn.type === 'assistant') as AssistantTurn[]
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.response?.messageId).toBe('answer')
    expect(assistant[0]!.activities.find(activity => activity.id === 'child')).toMatchObject({
      parentId: 'agent1', messageId: 'child', sourceMessageId: 'sdk-child', type: 'intermediate', content: 'Child answer',
    })
  })

  it('does not promote a child answer to the owner response when a turn ends on tools', () => {
    const turns = groupMessagesByTurn([
      { id: 'parent', role: 'tool', content: '', timestamp: 2, toolName: 'Agent', toolUseId: 'agent1', toolStatus: 'completed' },
      { id: 'child', role: 'assistant', content: 'Child answer', timestamp: 3, parentToolUseId: 'agent1', isIntermediate: true },
    ], { isSessionProcessing: false })
    const assistant = turns[0] as AssistantTurn
    expect(assistant.response).toBeUndefined()
    expect(assistant.activities.map(activity => activity.id)).toEqual(['parent', 'child'])
  })

  it('keeps a child proposal inside its parent and does not finish the owner turn', () => {
    const turns = groupMessagesByTurn([
      { id: 'parent', role: 'tool', content: '', timestamp: 1, toolName: 'Agent', toolUseId: 'agent1', toolStatus: 'executing' },
      { id: 'child-plan', role: 'plan', content: '# Child proposal', timestamp: 2, parentToolUseId: 'agent1' },
      { id: 'child-stream', role: 'assistant', content: 'Partial', timestamp: 3, parentToolUseId: 'agent1', isStreaming: true },
    ], { isSessionProcessing: true })
    const assistant = turns[0] as AssistantTurn
    expect(turns).toHaveLength(1)
    expect(assistant.isComplete).toBe(false)
    expect(assistant.activities.find(activity => activity.id === 'child-plan')?.parentId).toBe('agent1')
    expect(assistant.activities.find(activity => activity.id === 'child-stream')?.status).toBe('running')
  })

  it('continues to filter hidden system nudges before making display sections', () => {
    const turns = groupMessagesByTurn([
      { id: 'hidden', role: 'user', content: 'Internal wake-up', timestamp: 1, hidden: true },
      { id: 'answer', role: 'assistant', content: 'Visible answer', timestamp: 2 },
    ])
    expect(turns).toHaveLength(1)
    expect((turns[0] as AssistantTurn).response?.messageId).toBe('answer')
  })
})


describe('searchable chat narrative', () => {
  it('searches root and child commentary and plans without indexing raw tool output', () => {
    expect(getAssistantSearchText({ activities: [
      text('a1', 'sdk1', 'Root commentary'),
      { ...tool('a2'), content: 'Raw output must stay excluded' },
      { ...text('a3', 'sdk-child', 'Child commentary'), parentId: 'parent' },
      { ...text('a4', 'sdk-plan', 'Plan contents'), type: 'plan' },
    ], response: { ...response(), text: 'Final answer' } })).toBe('Root commentary\nChild commentary\nPlan contents\nFinal answer')
  })

  it('counts promoted commentary once by message identity without losing repeated separate messages', () => {
    expect(getAssistantSearchText({ activities: [text('a1', 'sdk1', 'Same text'), text('a2', 'sdk2', 'Same text')],
      response: { ...response('a2', 'sdk2'), text: 'Same text' },
    })).toBe('Same text\nSame text')
  })
})
