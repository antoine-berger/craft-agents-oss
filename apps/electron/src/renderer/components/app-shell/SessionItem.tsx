import { useTranslation } from "react-i18next"
import { Archive, ArchiveRestore, Flag } from "lucide-react"
import { useActionLabel } from "@/actions"
import { cn } from "@/lib/utils"
import { rendererPerf } from "@/lib/perf"
import { Spinner } from "@craft-agent/ui"
import { EntityRow } from "@/components/ui/entity-row"
import { EntityListBadge } from "@/components/ui/entity-list-badge"
import { SessionMenu } from "./SessionMenu"
import { BatchSessionMenu } from "./BatchSessionMenu"
import { CompactSessionMenu } from "./CompactSessionMenu"
import { SessionStatusIcon } from "./SessionStatusIcon"
import { SessionBadges } from "./SessionBadges"
import { SessionProjectColorWrapper } from "./SessionProjectColorWrapper"
import { hasTransferTargets } from "./transfer-targets"
import { useProjectColorTreatment } from "@/hooks/useProjectColorTreatment"
import { getSessionTitle, getSessionPreviewText, highlightMatch, hasUnreadMeta, formatShortAge } from "@/utils/session"
import { useSessionListContext } from "@/context/SessionListContext"
import { useAppShellContext } from "@/context/AppShellContext"
import { navigate, routes } from "@/lib/navigate"
import type { SessionMeta } from "@/atoms/sessions"
import { messagingBindingsBySessionAtom } from "@/atoms/messaging"
import { useAtomValue } from "jotai"
import { extractLabelId } from "@craft-agent/shared/labels"

/** Messaging bindings are labelled by platform name; the chip itself is neutral (labels are taxonomy, not status). */
const PLATFORM_LABEL: Record<'telegram' | 'whatsapp', string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
}

export interface SessionItemProps {
  item: SessionMeta
  index: number
  itemProps: Record<string, unknown>
  isSelected: boolean
  isFirstInGroup: boolean
  isInMultiSelect: boolean
  onSelect: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
}

/**
 * One session row (design spec §2.4 "one slot, one meaning", §7.2):
 * - leading glyph = the user's workflow status (click to change it)
 * - title (600 when unread) · age (unread: led by an 8px accent dot, age in accent)
 * - subtitle = run state with its own shape and color (needs you · working · failed · plan ready),
 *   else the labels (chips tinted with each label's color), else the session preview
 */
export function SessionItem({
  item,
  itemProps,
  isSelected,
  isFirstInGroup: _isFirstInGroup,
  isInMultiSelect,
  onSelect,
  onToggleSelect,
  onRangeSelect,
}: SessionItemProps) {
  const { t } = useTranslation()
  const ctx = useSessionListContext()
  const { workspaces, isCompactMode } = useAppShellContext()
  const canSendToWorkspace = hasTransferTargets(workspaces)
  const { hotkey: nextHotkey } = useActionLabel('chat.nextSearchMatch')
  const { hotkey: prevHotkey } = useActionLabel('chat.prevSearchMatch')
  const title = getSessionTitle(item)
  const archiveAction = item.isArchived ? ctx.onUnarchive : ctx.onArchive
  // For the active session, prefer logical match count over ripgrep count
  const activeMatch = ctx.activeChatMatchInfo
  const isActiveSession = isSelected && activeMatch?.sessionId === item.id
  const ripgrepMatchCount = ctx.contentSearchResults.get(item.id)?.matchCount
  const chatMatchCount = isActiveSession ? activeMatch!.count : ripgrepMatchCount
  const hasMatch = chatMatchCount != null && chatMatchCount > 0
  const hasLabels = !!(item.labels && item.labels.length > 0 && ctx.flatLabels.length > 0 && item.labels.some(entry => {
    const labelId = extractLabelId(entry)
    return ctx.flatLabels.some(l => l.id === labelId)
  }))
  const attention = ctx.attention?.[item.id]
  const hasServerAttention = attention?.status === 'needs-human'
  const hasPendingPrompt = ctx.hasPendingPrompt?.(item.id) ?? false
  const isUnread = hasUnreadMeta(item)
  const messagingBindingsBySession = useAtomValue(messagingBindingsBySessionAtom)
  const sessionBindings = messagingBindingsBySession.get(item.id) ?? []
  const hasMessagingBinding = sessionBindings.length > 0

  // Attention replaces the leading status glyph; ordinary working/preview content stays in its row.
  const runState: 'needs-you' | 'working' | 'failed' | 'plan' | null = (hasPendingPrompt || hasServerAttention)
    ? 'needs-you'
    : (item.isProcessing || attention?.status === 'working')
      ? 'working'
      : item.lastMessageRole === 'error'
        ? 'failed'
        : item.lastMessageRole === 'plan'
          ? 'plan'
          : null
  const needsAttention = runState === 'needs-you' || runState === 'failed' || runState === 'plan'
  // Keep the normal preview/labels instead of adding a second attention indicator.
  const previewText = runState === 'working' || hasLabels ? null : getSessionPreviewText(item)

  // Resolve the bound project so the row can show a project-themed stripe /
  // tint and reveal the project name on hover. Treatment is a user preference
  // under Appearance.
  const projectColorTreatment = useProjectColorTreatment()
  const boundProject = item.projectId
    ? ctx.projects?.find(p => p.id === item.projectId)
    : undefined
  const projectColor = boundProject?.color
  const projectName = boundProject?.name

  const handleClick = (e: React.MouseEvent) => {
    ctx.onFocusZone()
    if (e.button === 2) {
      if (ctx.isMultiSelectActive && !isInMultiSelect && onToggleSelect) onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      // Cmd+Shift+Click: open session in a new panel
      e.preventDefault()
      navigate(routes.view.allSessions(item.id), { newPanel: true })
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      // Cmd+Click: always toggle multi-select (standard OS behavior)
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    rendererPerf.startSessionSwitch(item.id)
    onSelect()
  }

  const subtitle = runState === 'working' ? (
    <span className="flex items-center gap-1.5 min-w-0">
      <Spinner className="text-label text-accent shrink-0" />
      <span className="truncate">{t("session.runState.working")}</span>
    </span>
  ) : previewText

  return (
    <SessionProjectColorWrapper color={projectColor} treatment={projectColorTreatment}>
    <EntityRow
      className="session-item"
      dataAttributes={{ 'data-session-id': item.id }}
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      // When a project stripe is drawn at the leading edge, suppress EntityRow's
      // own multi-select bar so they don't stack. The row's background tint
      // continues to convey "selected".
      suppressSelectionBar={!!projectColor}
      onMouseDown={handleClick}
      buttonProps={{
        ...itemProps,
        onKeyDown: (e: React.KeyboardEvent) => {
          ;(itemProps as { onKeyDown: (event: React.KeyboardEvent) => void }).onKeyDown(e)
          ctx.onKeyDown(e, item)
        },
      }}
      moreButtonLabel={t("session.actionsFor", { title })}
      actionButton={archiveAction ? {
        icon: item.isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
        label: `${t(item.isArchived ? "sessionMenu.unarchive" : "sessionMenu.archive")}: ${title}`,
        onClick: () => archiveAction(item.id),
      } : undefined}
      menuContent={
        <SessionMenu
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          onLabelsChange={ctx.onLabelsChange ? (ls) => ctx.onLabelsChange!(item.id, ls) : undefined}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          hasTransferTargets={canSendToWorkspace}
          onDelete={() => ctx.onDelete(item.id)}
          projects={ctx.projects}
          onSetProjectId={ctx.onSetProjectId ? (pid) => ctx.onSetProjectId!(item.id, pid) : undefined}
        />
      }
      contextMenuContent={ctx.isMultiSelectActive && isInMultiSelect ? <BatchSessionMenu /> : undefined}
      isCompactMode={isCompactMode}
      compactMenu={({ open, onOpenChange }) => (
        <CompactSessionMenu
          open={open}
          onOpenChange={onOpenChange}
          trigger={null}
          title={title}
          item={item}
          sessionStatuses={ctx.sessionStatuses}
          labels={ctx.labels}
          hasTransferTargets={canSendToWorkspace}
          onLabelsChange={ctx.onLabelsChange ? (ls) => ctx.onLabelsChange!(item.id, ls) : undefined}
          onRename={() => ctx.onRenameClick(item.id, title)}
          onFlag={() => ctx.onFlag?.(item.id)}
          onUnflag={() => ctx.onUnflag?.(item.id)}
          onArchive={() => ctx.onArchive?.(item.id)}
          onUnarchive={() => ctx.onUnarchive?.(item.id)}
          onMarkUnread={() => ctx.onMarkUnread(item.id)}
          onSessionStatusChange={(s) => ctx.onSessionStatusChange(item.id, s)}
          onOpenInNewWindow={() => ctx.onOpenInNewWindow(item)}
          onSendToWorkspace={ctx.onSendToWorkspace ? () => ctx.onSendToWorkspace!([item.id]) : undefined}
          onDelete={() => ctx.onDelete(item.id)}
        />
      )}
      icon={<SessionStatusIcon item={item} needsAttention={needsAttention} attentionDescription={attention?.reasons.map(reason => reason.title).join("; ")} />}
      title={ctx.searchQuery ? highlightMatch(title, ctx.searchQuery) : title}
      titleClassName={cn(isUnread && "font-semibold", item.isAsyncOperationOngoing && "animate-shimmer-text")}
      subtitle={subtitle}
      subtitleTrailing={hasLabels ? <SessionBadges item={item} /> : undefined}
      titleSuffix={
        (projectName || hasMessagingBinding) ? (
          <div className="flex items-center gap-1">
            {projectName && (
              // Revealed on hover/focus only, and out of the layout otherwise: an invisible (opacity-0)
              // name still reserved its width and cut the title short for nothing. Solved tertiary
              // text, not the raw project color (purple text failed AA); the stripe carries the color.
              <span
                className="hidden group-hover:inline group-focus-within:inline text-label-sm text-tertiary whitespace-nowrap truncate max-w-[120px]"
                title={projectName}
              >
                {projectName}
              </span>
            )}
            {hasMessagingBinding && sessionBindings.map((binding) => {
              const label = PLATFORM_LABEL[binding.platform as 'telegram' | 'whatsapp']
              if (!label) return null
              return (
                <EntityListBadge
                  key={binding.id}
                  variant="text"
                  colorClass="bg-fill-hover text-secondary"
                  tooltip={`Connected to ${label}`}
                >
                  {label}
                </EntityListBadge>
              )
            })}
          </div>
        ) : undefined
      }
      titleTrailing={isUnread && !hasMatch ? (
        // Unread: an accent dot leads the meta and the age turns accent, so the signal sits on the
        // row's own grid (the trailing slot) instead of floating in the bleed past the gutter.
        <span className="inline-flex items-center gap-1.5 text-accent">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent-solid" />
          <span className="sr-only">{t("session.unreadIndicator")}</span>
          {item.isFlagged ? (
            <Flag className="size-3.5 text-info" aria-label={t("sidebar.flagged")} />
          ) : item.lastMessageAt ? (
            formatShortAge(item.lastMessageAt)
          ) : null}
        </span>
      ) : hasMatch ? (
        <span
          className="inline-flex h-[18px] min-w-6 items-center justify-center rounded-xs px-1 text-caption tabular-nums bg-info-tint text-info"
          title={`Matches found (${nextHotkey} next, ${prevHotkey} prev)`}
        >
          {chatMatchCount}
        </span>
      ) : item.isFlagged ? (
        <Flag className="size-3.5 text-info" aria-label={t("sidebar.flagged")} />
      ) : item.lastMessageAt ? (
        <span>
          {formatShortAge(item.lastMessageAt)}
        </span>
      ) : undefined}
    />
    </SessionProjectColorWrapper>
  )
}
