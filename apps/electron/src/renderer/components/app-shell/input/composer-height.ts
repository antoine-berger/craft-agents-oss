import { getStructuredInputMaxHeight } from './structured-height'

/** The freeform budget includes its action row, not just the editable text. */
export function getComposerMaxHeight(availableHeight: number, mode: 'freeform' | 'structured', appearance: 'default' | 'chat' = 'default'): number {
  if (mode === 'freeform' && appearance === 'chat') {
    return Number.isFinite(availableHeight) ? Math.min(250, Math.max(0, availableHeight)) : 250
  }
  if (!Number.isFinite(availableHeight)) return mode === 'freeform' ? 584 : 480
  const available = Math.max(0, availableHeight)
  return mode === 'freeform'
    ? Math.min(584, Math.floor(available * 0.66))
    : Math.min(available, getStructuredInputMaxHeight(available))
}
