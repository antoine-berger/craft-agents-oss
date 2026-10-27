/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching. */
export type FilterMode = 'include' | 'exclude'

export interface InheritedNewSessionParams {
  status?: string
  label?: string
  project?: string
}

const includeKeys = <K extends string>(m: Map<K, FilterMode>): K[] =>
  [...m.entries()].filter(([, mode]) => mode === 'include').map(([id]) => id)

/**
 * A project is context, independent of status/label filtering. An open project page or a
 * single included project must survive combined filters; exclusions never become defaults.
 * Status/label inheritance retains the sole-include rule when their choice is unambiguous.
 */
export function resolveInheritedFilterParams<S extends string, L extends string, P extends string>(
  statusFilter: Map<S, FilterMode>,
  labelFilter: Map<L, FilterMode>,
  projectFilter: Map<P, FilterMode>,
  openedProjectId?: string,
): InheritedNewSessionParams | null {
  const statusIncludes = includeKeys(statusFilter)
  const labelIncludes = includeKeys(labelFilter)
  const projectIncludes = includeKeys(projectFilter)
  const project = openedProjectId ?? (projectIncludes.length === 1 ? projectIncludes[0] : undefined)
  if (project) {
    const metadataCount = statusIncludes.length + labelIncludes.length
    return {
      project,
      ...(metadataCount === 1 && statusIncludes.length === 1 ? { status: statusIncludes[0] } : {}),
      ...(metadataCount === 1 && labelIncludes.length === 1 ? { label: labelIncludes[0] } : {}),
    }
  }
  const total = statusIncludes.length + labelIncludes.length + projectIncludes.length
  if (total !== 1) return null
  if (statusIncludes.length === 1) return { status: statusIncludes[0] }
  if (labelIncludes.length === 1) return { label: labelIncludes[0] }
  if (projectIncludes.length === 1) return { project: projectIncludes[0] }
  return null
}
