/**
 * ChatHeader — the chat panel's header (design spec §7.3).
 *
 * Desktop: title (click to rename) · compact PR chip · Changes · ⋯ · close. Session metadata lives here rather than in a badge row
 * above the composer.
 *
 * Compact shell: back · status glyph · title · ⋯. The drawer behind ⋯ also holds Session info and
 * Share, and the status glyph opens it on its Status pane. The panel's close button is dropped:
 * back closes the same panel.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { History, Info, MoreHorizontal, Pencil, GitCompareArrows, PanelRight } from 'lucide-react'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { useAppShellContext } from '@/context/AppShellContext'
import { kanbanEditorTargetAtom } from '@/atoms/kanban'
import type { SessionMeta } from '@/atoms/sessions'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { PanelHeader } from '../PanelHeader'
import { SessionMenu } from '../SessionMenu'
import { CompactSessionMenu } from '../CompactSessionMenu'
import { SessionInfoPopover } from '../SessionInfoPopover'
import { PrQuickActions } from './pr-watch/PrQuickActions'
import { ChatHeaderPrChip } from './pr-watch/ChatHeaderPrChip'
import { isPrWatchVisible, type PrEntry, type PrMergeMethod, type PrWatchState } from './pr-watch/pr-watch-state'
import type { PrAutoFixView, PrAutoMergeChange, PrWatchNav } from '@/hooks/usePrWatch'

export interface ChatHeaderProps {
  sessionId: string
  /** Session metadata. Without it the header shows only the title. */
  item?: SessionMeta
  title: string
  /** Shimmer while the title is being regenerated */
  isRegeneratingTitle?: boolean
  /** Published viewer link; the loaded session can know it before the metadata does */
  sharedUrl?: string | null
  onOpenHistory?: () => void
  onReviewChanges?: () => void
  onToggleWorkbench?: () => void
  workbenchOpen?: boolean
  workingDirectory?: string
  sessionFolderPath?: string
  /** The active pull request; shown on the desktop layout */
  prWatch?: PrWatchState
  /** The session's PRs (branch PR + pinned PRs); with more than one the chip shows "+N" */
  prWatchNav?: PrWatchNav
  /** Where the active PR came from — only `bound` PRs get an Unpin action */
  prWatchActiveOrigin?: PrEntry['origin']
  onRefreshPrWatch?: () => void
  /** Remove the active (bound) PR from the session */
  onUnbindPr?: (ref: string) => void
  /** Toggle GitHub auto-merge on the active PR; resolves with GitHub's answer */
  onSetPrAutoMerge?: (ref: string, enabled: boolean, method?: PrMergeMethod) => Promise<PrAutoMergeChange>
  /** Auto-fix (the card's Fix toggle) for the active PR */
  prWatchAutoFix?: PrAutoFixView
  onSetPrAutoFix?: (enabled: boolean) => void
  /** The PR card opened or closed (details load while it is open) */
  onPrCardOpenChange?: (open: boolean) => void
}

type DrawerState = { open: boolean; view: 'root' | 'status' }

function sameFields<T extends object>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a) as Array<keyof T>
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]))
}

/**
 * ChatPage re-renders on every streamed delta, and each delta also writes a fresh (field-for-field equal)
 * session-meta object. Comparing the meta by fields lets the header skip those renders.
 */
function sameHeaderProps(prev: ChatHeaderProps, next: ChatHeaderProps): boolean {
  return prev.sessionId === next.sessionId
    && prev.title === next.title
    && prev.isRegeneratingTitle === next.isRegeneratingTitle
    && prev.sharedUrl === next.sharedUrl
    && prev.onOpenHistory === next.onOpenHistory
    && prev.onReviewChanges === next.onReviewChanges
    && prev.onToggleWorkbench === next.onToggleWorkbench
    && prev.workbenchOpen === next.workbenchOpen
    && prev.workingDirectory === next.workingDirectory
    && prev.sessionFolderPath === next.sessionFolderPath
    && prev.prWatch === next.prWatch
    && prev.prWatchNav === next.prWatchNav
    && prev.prWatchActiveOrigin === next.prWatchActiveOrigin
    && prev.onRefreshPrWatch === next.onRefreshPrWatch
    && prev.onUnbindPr === next.onUnbindPr
    && prev.onSetPrAutoMerge === next.onSetPrAutoMerge
    && prev.prWatchAutoFix === next.prWatchAutoFix
    && prev.onSetPrAutoFix === next.onSetPrAutoFix
    && prev.onPrCardOpenChange === next.onPrCardOpenChange
    && sameFields(prev.item, next.item)
}

export const ChatHeader = React.memo(function ChatHeader({
  sessionId,
  item: metaItem,
  title,
  isRegeneratingTitle,
  sharedUrl,
  onReviewChanges,
  onToggleWorkbench,
  workbenchOpen,
  onOpenHistory,
  workingDirectory,
  sessionFolderPath,
  prWatch,
  prWatchNav,
  prWatchActiveOrigin,
  onRefreshPrWatch,
  onUnbindPr,
  onSetPrAutoMerge,
  prWatchAutoFix,
  onSetPrAutoFix,
  onPrCardOpenChange,
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const {
    isCompactMode,
    leadingAction,
    rightSidebarButton,
    sessionStatuses = [],
    labels = [],
    onRenameSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onMarkSessionUnread,
    onSessionStatusChange,
    onSessionLabelsChange,
    onDeleteSession,
  } = useAppShellContext()
  const compact = !!isCompactMode

  const item = React.useMemo(() => {
    if (!metaItem || !sharedUrl || metaItem.sharedUrl === sharedUrl) return metaItem
    return { ...metaItem, sharedUrl }
  }, [metaItem, sharedUrl])

  // ── Session actions (shared by the desktop ⋯ menu and the compact drawer) ──
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState('')
  const openRename = React.useCallback(() => {
    setRenameValue(title)
    setRenameOpen(true)
  }, [title])
  const submitRename = React.useCallback(() => {
    const next = renameValue.trim()
    if (next && next !== title) onRenameSession(sessionId, next)
    setRenameOpen(false)
  }, [renameValue, title, onRenameSession, sessionId])

  const handleLabelsChange = React.useCallback((next: string[]) => {
    onSessionLabelsChange?.(sessionId, next)
  }, [onSessionLabelsChange, sessionId])
  const handleStatusChange = React.useCallback((statusId: string) => {
    onSessionStatusChange(sessionId, statusId)
  }, [onSessionStatusChange, sessionId])
  const handleFlag = React.useCallback(() => onFlagSession(sessionId), [onFlagSession, sessionId])
  const handleUnflag = React.useCallback(() => onUnflagSession(sessionId), [onUnflagSession, sessionId])
  const handleArchive = React.useCallback(() => onArchiveSession(sessionId), [onArchiveSession, sessionId])
  const handleUnarchive = React.useCallback(() => onUnarchiveSession(sessionId), [onUnarchiveSession, sessionId])
  const handleMarkUnread = React.useCallback(() => onMarkSessionUnread(sessionId), [onMarkSessionUnread, sessionId])
  const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [onDeleteSession, sessionId])
  const handleOpenInNewWindow = React.useCallback(async () => {
    const route = routes.view.allSessions(sessionId)
    const separator = route.includes('?') ? '&' : '?'
    try {
      await window.electronAPI?.openUrl(`craftagents://${route}${separator}window=focused`)
    } catch (error) {
      console.error('[ChatHeader] openUrl failed:', error)
    }
  }, [sessionId])

  // Task orchestrator sessions (spec-backed, top-level) get an "Edit task" action that opens the
  // board's full-pane Task editor prefilled from task.yaml.
  const taskSlug = item?.taskSlug
  const isTaskOrchestrator = !!taskSlug && !item?.parentSessionId
  const setKanbanEditorTarget = useSetAtom(kanbanEditorTargetAtom)
  const handleEditTask = React.useCallback(() => {
    if (!taskSlug) return
    setKanbanEditorTarget({ mode: 'edit', sessionId, taskSlug, initialTitle: title })
    navigate(routes.view.board())
  }, [taskSlug, sessionId, title, setKanbanEditorTarget])

  // ── Compact: one drawer for ⋯ and the status glyph, plus the Session info sheet ──
  const [drawer, setDrawer] = React.useState<DrawerState>({ open: false, view: 'root' })
  // Stable: CompactSessionMenu closes itself whenever this identity changes.
  const handleDrawerOpenChange = React.useCallback((open: boolean) => {
    setDrawer(current => ({ ...current, open }))
  }, [])
  const [infoOpen, setInfoOpen] = React.useState(false)
  const infoOpenRef = React.useRef(false)
  infoOpenRef.current = infoOpen
  const showInfo = React.useCallback(() => { infoOpenRef.current = true; requestAnimationFrame(() => setInfoOpen(true)) }, [])
  // The drawer has no trigger of its own (⋯ and the status glyph both open it), so focus goes back to
  // whichever opened it, unless "Session info" handed off to the info sheet.
  const drawerOpenerRef = React.useRef<HTMLElement | null>(null)
  const openDrawer = React.useCallback((view: DrawerState['view'], opener: HTMLElement) => {
    drawerOpenerRef.current = opener
    setDrawer({ open: true, view })
  }, [])
  const handleDrawerCloseAutoFocus = React.useCallback((event: Event) => {
    event.preventDefault()
    if (!infoOpenRef.current) drawerOpenerRef.current?.focus()
  }, [])
  // Overlays of one layout must not come back open when the window crosses the compact breakpoint and back.
  React.useEffect(() => {
    setDrawer(current => (current.open ? { ...current, open: false } : current))
    setInfoOpen(false)
  }, [compact])

  const showPrChip = !compact && isPrWatchVisible(prWatch)

  const titleRow = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <h1 className={cn('min-w-0 flex-1 font-sans text-label-lg font-normal')}>
        <button
          type="button"
          onClick={openRename}
          title={t('chat.renameSession')}
          className={cn(
            // Renaming is a tap target in the compact header too: 44px tall there, like its buttons.
            'titlebar-no-drag block h-control in-data-compact:h-11 max-w-full truncate rounded-md px-1.5 text-left',
            'hover:bg-fill-hover active:bg-fill-pressed transition-[background-color] duration-micro ease-out-subtle hover:duration-instant',
          )}
        >
          <span className={cn(isRegeneratingTitle && 'animate-shimmer-text')}>{title}</span>
        </button>
      </h1>
      {showPrChip && prWatch && (
        <ChatHeaderPrChip
          state={prWatch}
          nav={prWatchNav}
        />
      )}
      {!compact && workingDirectory && prWatch && <PrQuickActions
        key={sessionId} sessionId={sessionId} state={prWatch} origin={prWatchActiveOrigin}
        onRefresh={onRefreshPrWatch} onSetAutoMerge={onSetPrAutoMerge}
      />}
    </div>
  )

  const moreLabel = t('session.actionsFor', { title })
  const actions = (
    <div className="flex items-center gap-1">
      {onToggleWorkbench && <PanelHeaderCenterButton icon={<PanelRight className="size-4" />} tooltip="Worktree tools · ⌘⇧B" aria-pressed={workbenchOpen} onClick={onToggleWorkbench} />}
      {onReviewChanges && <PanelHeaderCenterButton
        icon={<><GitCompareArrows className="h-4 w-4" />{!compact && <span>{t('gitReview.shortTitle', { defaultValue: 'Changes' })}</span>}</>}
        className={compact ? undefined : 'w-auto gap-1.5 px-2 text-label-sm'}
        tooltip={t('gitReview.title', { defaultValue: 'Review changes' })} onClick={onReviewChanges} />}
      {isTaskOrchestrator && compact && (
        <PanelHeaderCenterButton
          icon={<Pencil className="h-4 w-4" />}
          tooltip={t('kanban.editTask')}
          onClick={handleEditTask}
        />
      )}
      {item && !compact && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PanelHeaderCenterButton icon={<MoreHorizontal className="h-4 w-4" />} aria-label={moreLabel} />
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" sideOffset={8} onCloseAutoFocus={event => { if (infoOpenRef.current) event.preventDefault() }}>
            {onOpenHistory && <StyledDropdownMenuItem onSelect={onOpenHistory}>
              <History className="h-3.5 w-3.5" /><span>{t('checkpoints.history', { defaultValue: 'History' })}</span>
            </StyledDropdownMenuItem>}
            <StyledDropdownMenuItem onSelect={showInfo}>
              <Info className="h-3.5 w-3.5" /><span>{t('chat.sessionInfo')}</span>
            </StyledDropdownMenuItem>
            {isTaskOrchestrator && <StyledDropdownMenuItem onSelect={handleEditTask}>
              <Pencil className="h-3.5 w-3.5" /><span>{t('kanban.editTask')}</span>
            </StyledDropdownMenuItem>}
            <StyledDropdownMenuSeparator />
            <SessionMenu
              item={item}
              sessionStatuses={sessionStatuses}
              labels={labels}
              onLabelsChange={handleLabelsChange}
              onRename={openRename}
              onFlag={handleFlag}
              onUnflag={handleUnflag}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onMarkUnread={handleMarkUnread}
              onSessionStatusChange={handleStatusChange}
              onOpenInNewWindow={handleOpenInNewWindow}
              onDelete={handleDelete}
            />
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
      {item && compact && (
        <PanelHeaderCenterButton
          icon={<MoreHorizontal className="h-4 w-4" />}
          aria-label={moreLabel}
          aria-haspopup="dialog"
          aria-expanded={drawer.open && drawer.view === 'root'}
          onClick={(event) => openDrawer('root', event.currentTarget)}
        />
      )}
    </div>
  )

  return (
    <>
      <PanelHeader
        titleRow={titleRow}
        actions={actions}
        leadingAction={leadingAction}
        rightSidebarButton={compact && leadingAction ? undefined : rightSidebarButton}
      />
      {item && compact && (
        <>
          <CompactSessionMenu
            title={title}
            item={item}
            sessionStatuses={sessionStatuses}
            labels={labels}
            onLabelsChange={handleLabelsChange}
            onRename={openRename}
            onFlag={handleFlag}
            onUnflag={handleUnflag}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onMarkUnread={handleMarkUnread}
            onSessionStatusChange={handleStatusChange}
            onOpenInNewWindow={handleOpenInNewWindow}
            onDelete={handleDelete}
            onShowInfo={showInfo}
            onShowHistory={onOpenHistory}
            open={drawer.open}
            onOpenChange={handleDrawerOpenChange}
            initialView={drawer.view}
            onCloseAutoFocus={handleDrawerCloseAutoFocus}
          />
        </>
      )}
      {item && <SessionInfoPopover
        sessionId={sessionId} sessionFolderPath={sessionFolderPath}
        presentation={compact ? 'drawer' : 'dialog'}
        side="bottom" align="end" open={infoOpen} onOpenChange={setInfoOpen}
      />}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={t('chat.renameSession')}
        value={renameValue}
        onValueChange={setRenameValue}
        onSubmit={submitRename}
        placeholder={t('chat.enterSessionName')}
      />
    </>
  )
}, sameHeaderProps)
