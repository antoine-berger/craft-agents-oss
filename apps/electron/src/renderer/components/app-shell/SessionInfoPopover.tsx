import * as React from 'react'
import type { SessionCheckpointList } from '@craft-agent/shared/protocol'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppShellContext, useSession } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { SessionFilesSection } from '../right-sidebar/SessionFilesSection'
import { Button } from '@/components/ui/button'
import { WorktreeStackSection } from '../worktree-stack/WorktreeStackSection'
import { ShipUsageSection } from './ShipUsageSection'
import { navigate, routes } from '@/lib/navigate'

interface SessionInfoPopoverProps {
  sessionId: string
  sessionFolderPath?: string
  /** Opens the panel; omit it and drive `open` instead (the compact chat header opens it from its drawer) */
  trigger?: React.ReactElement
  /** Controlled open state; when omitted the component owns it */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  contentClassName?: string
  presentation?: 'popover' | 'drawer' | 'dialog'
}

// The popover and sheet materials come from PopoverContent / DrawerContent; these only size them.
// The popover hugs its content up to 460px (the file list scrolls inside); a fixed height left a
// mostly empty card for sessions with few files.
const DEFAULT_POPOVER_CONTENT_CLASS = 'flex w-[360px] max-h-[460px] min-w-[200px] max-w-[420px] flex-col overflow-hidden p-0'
const DEFAULT_DRAWER_CONTENT_CLASS = 'overflow-hidden'

export function SessionInfoPopover({
  sessionId,
  sessionFolderPath,
  trigger,
  open: controlledOpen,
  onOpenChange,
  side = 'top',
  align = 'end',
  sideOffset = 6,
  contentClassName,
  presentation = 'popover',
}: SessionInfoPopoverProps) {
  const { t } = useTranslation()
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)

    if (!nextOpen) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('craft:focus-input', {
          detail: { sessionId },
        }))
      })
    }
  }, [controlledOpen, onOpenChange, sessionId])

  if (presentation === 'dialog') {
    return <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex w-[420px] max-w-[calc(100vw-32px)] max-h-[80vh] flex-col gap-0 overflow-hidden p-0" aria-describedby={undefined}>
        <DialogHeader className="border-b border-subtle px-4 py-3">
          <DialogTitle>{t('chat.sessionInfo')}</DialogTitle>
        </DialogHeader>
        <SessionInfoPopoverContent sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </DialogContent>
    </Dialog>
  }

  if (presentation === 'drawer') {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange} direction="bottom">
        {trigger && (
          <DrawerTrigger asChild>
            {trigger}
          </DrawerTrigger>
        )}
        <DrawerContent
          className={cn(DEFAULT_DRAWER_CONTENT_CLASS, contentClassName)}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
          }}
        >
          <DrawerHeader className="border-b border-subtle px-4 py-3">
            <DrawerTitle>{t('chat.sessionInfo')}</DrawerTitle>
          </DrawerHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <SessionInfoPopoverContent sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {trigger && (
        <PopoverTrigger asChild>
          {trigger}
        </PopoverTrigger>
      )}
      <PopoverContent
        className={contentClassName ?? DEFAULT_POPOVER_CONTENT_CLASS}
        side={side}
        align={align}
        sideOffset={sideOffset}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
        }}
      >
        <SessionInfoPopoverContent sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </PopoverContent>
    </Popover>
  )
}

function SessionInfoPopoverContent({ sessionId, sessionFolderPath }: { sessionId: string; sessionFolderPath?: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const { onRenameSession } = useAppShellContext()
  const [name, setName] = React.useState('')
  const [associating, setAssociating] = React.useState(false)
  const [associationError, setAssociationError] = React.useState<string>()
  const [associated, setAssociated] = React.useState(false)
  const [checkpointReadiness, setCheckpointReadiness] = React.useState<SessionCheckpointList>()
  const associationRequest = React.useRef(0)
  const renameTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    setName(session?.name || '')
  }, [session?.name])
  React.useEffect(() => {
    associationRequest.current++
    setAssociated(false); setAssociationError(undefined); setAssociating(false); setCheckpointReadiness(undefined)
    return () => { associationRequest.current++ }
  }, [sessionId])
  React.useEffect(() => {
    if (!session?.worktree?.owned?.adopted) return
    let cancelled = false
    window.electronAPI.listSessionCheckpoints(sessionId).then(result => {
      if (!cancelled) setCheckpointReadiness(result)
    }, error => {
      if (!cancelled) setAssociationError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [sessionId, session?.worktree?.owned?.adopted, session?.worktree?.owned?.path])
  const associateCheckpoints = async () => {
    if (associating || !session || session.isArchived) return
    const requestedSession = sessionId
    const request = ++associationRequest.current
    setAssociating(true); setAssociationError(undefined)
    try {
      const readiness = await window.electronAPI.adoptSessionCheckpointWorktree(requestedSession)
      if (associationRequest.current === request) {
        setAssociated(true)
        setCheckpointReadiness(readiness)
      }
    } catch (error) { if (associationRequest.current === request) setAssociationError(error instanceof Error ? error.message : String(error)) }
    finally { if (associationRequest.current === request) setAssociating(false) }
  }

  React.useEffect(() => {
    return () => {
      if (renameTimeoutRef.current) {
        clearTimeout(renameTimeoutRef.current)
      }
    }
  }, [])

  const handleNameChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value
    setName(newName)

    if (renameTimeoutRef.current) {
      clearTimeout(renameTimeoutRef.current)
    }

    renameTimeoutRef.current = setTimeout(() => {
      const trimmed = newName.trim()
      if (trimmed) {
        onRenameSession(sessionId, trimmed)
      }
    }, 500)
  }, [onRenameSession, sessionId])

  const canAssociate = session?.importedFrom && session.workingDirectory && !session.worktree?.owned && !associated && !session.isArchived
  const unsupportedReason = checkpointReadiness && !checkpointReadiness.supported
    ? checkpointReadiness.reason || 'This worktree does not support checkpoints.'
    : undefined

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 16px insets, the same edge as the Session Files header and rows below */}
      <div className="shrink-0 px-4 py-3 border-b border-subtle">
        <label htmlFor={`session-info-title-${sessionId}`} className="text-label-sm font-medium text-secondary block mb-1.5 select-none">
          {t("chat.title")}
        </label>
        <Input
          id={`session-info-title-${sessionId}`}
          value={name}
          onChange={handleNameChange}
          placeholder={t("chat.titlePlaceholder")}
        />
      </div>
      {(canAssociate || unsupportedReason || associationError) && <div className="shrink-0 border-b border-subtle px-4 py-3">
        {canAssociate && <><Button variant="outline" size="sm" disabled={associating || session?.isProcessing} onClick={() => void associateCheckpoints()}>
          {associating ? 'Associating worktree…' : 'Enable future checkpoints'}
        </Button>
        <p className="mt-1.5 text-label-sm text-secondary">Uses the current checkout. Existing files and history stay in place.</p></>}
        {unsupportedReason && <p role="status" className="text-label-sm text-secondary">Checkpoints unavailable: {unsupportedReason}</p>}
        {associationError && <p role="alert" className="mt-1.5 text-label-sm text-destructive">{associationError}</p>}
      </div>}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {session?.workingDirectory && <WorktreeStackSection key={`stack:${sessionId}`} sessionId={sessionId} api={window.electronAPI} onOpenSession={id => navigate(routes.view.allSessions(id))} />}
        {session?.workingDirectory && <ShipUsageSection key={`usage:${sessionId}`} sessionId={sessionId} api={window.electronAPI} />}
        <SessionFilesSection
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
          hideHeader={false}
          className="h-full min-h-0"
        />
      </div>
    </div>
  )
}
