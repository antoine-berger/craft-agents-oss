import type { SessionMeta } from '@/atoms/sessions'

export interface ProjectPilot { id: string; pilotSessionId?: string }

export function isProjectPilot(id: string, projects: readonly ProjectPilot[]): boolean {
  return projects.some(project => project.pilotSessionId === id)
}

/** Pilot chats have a dedicated slot in one project, never a task-status bucket. */
export function projectPilotRows(items: SessionMeta[], projects: readonly ProjectPilot[], projectId?: string): SessionMeta[] {
  const pilotId = projects.find(project => project.id === projectId)?.pilotSessionId
  return pilotId ? items.filter(item => item.id === pilotId && !item.hidden && !item.isArchived) : []
}

export function projectTaskRows(items: SessionMeta[], projects: readonly ProjectPilot[]): SessionMeta[] {
  return items.filter(item => !isProjectPilot(item.id, projects))
}
