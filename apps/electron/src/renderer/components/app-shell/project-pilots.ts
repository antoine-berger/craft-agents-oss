import type { SessionMeta } from '@/atoms/sessions'

export interface ProjectPilot { id: string; pilotSessionId?: string }

export function isProjectPilot(id: string, projects: readonly ProjectPilot[]): boolean {
  return projects.some(project => project.pilotSessionId === id)
}

/** Keep pilots above task groups, both in All Sessions and in the selected projects. */
export function projectPilotRows(items: SessionMeta[], projects: readonly ProjectPilot[], projectId?: string, projectFilter: ReadonlyMap<string, 'include' | 'exclude'> = new Map()): SessionMeta[] {
  const included = new Set([...projectFilter].filter(([, mode]) => mode === 'include').map(([id]) => id))
  const pilotIds = new Set(projects.filter(project => (projectId === undefined || project.id === projectId)
    && projectFilter.get(project.id) !== 'exclude' && (included.size === 0 || included.has(project.id))).map(project => project.pilotSessionId))
  return items.filter(item => pilotIds.has(item.id) && !item.hidden && !item.isArchived)
}

export function projectTaskRows(items: SessionMeta[], projects: readonly ProjectPilot[]): SessionMeta[] {
  return items.filter(item => !isProjectPilot(item.id, projects))
}
