import { expect, test } from 'bun:test'
import type { SessionMeta } from '@/atoms/sessions'
import { projectPilotRows, projectTaskRows } from '../project-pilots'
import { computeCollapsedPagination, sortSessionsForGrouping } from '@/hooks/useSessionSearch'

const projects = [{ id: 'p1', pilotSessionId: 'pilot-1' }, { id: 'p2', pilotSessionId: 'pilot-2' }]
const session = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({ id, workspaceId: 'w', sessionStatus: 'in-progress', ...patch })
const items = [session('pilot-1', { projectId: 'p1' }), session('pilot-2', { projectId: 'p2' }), session('task', { name: 'Pilote', projectId: 'p1' })]

test('All Sessions status grouping and counts exclude every project pilot by ID, not by title', () => {
  const tasks = projectTaskRows(items, projects)
  const grouped = computeCollapsedPagination(sortSessionsForGrouping(tasks, 'status'), 50, undefined, 'status')
  expect(grouped.paginatedItems.map(s => s.id)).toEqual(['task'])
  expect(tasks.filter(s => s.sessionStatus === 'in-progress')).toHaveLength(1)
  expect(projectTaskRows(items.slice(0, 2), projects)).toEqual([])
  expect(projectPilotRows(items, projects)).toEqual([])
})

test('only the selected project gets its own dedicated pilot, outside task buckets', () => {
  for (const project of projects) {
    expect(projectPilotRows(items, projects, project.id).map(s => s.id)).toEqual([project.pilotSessionId])
  }
  expect(projectPilotRows(items, projects, 'unknown')).toEqual([])
})

test('project pilot reference remains authoritative for missing project metadata, and hidden/archived pilots never pin', () => {
  expect(projectPilotRows([session('pilot-1')], projects, 'p1')).toHaveLength(1)
  expect(projectPilotRows([session('pilot-1', { isArchived: true })], projects, 'p1')).toEqual([])
  expect(projectPilotRows([session('pilot-1', { hidden: true })], projects, 'p1')).toEqual([])
  expect(projectTaskRows([session('task')], [])).toHaveLength(1)
})
