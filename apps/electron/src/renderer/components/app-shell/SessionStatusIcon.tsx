import { useState } from "react"
import { Hand } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SessionStatusMenu } from "@/components/ui/session-status-menu"
import { getStateIcon, getStateIconStyle } from "@/config/session-status-config"
import { useSessionListContext } from "@/context/SessionListContext"
import type { SessionMeta } from "@/atoms/sessions"
import { getSessionStatus } from "@/utils/session"

interface SessionStatusIconProps {
  item: SessionMeta
  needsAttention?: boolean
  attentionDescription?: string
}

export function SessionStatusIcon({ item, needsAttention = false, attentionDescription }: SessionStatusIconProps) {
  const { t } = useTranslation()
  const ctx = useSessionListContext()
  const [open, setOpen] = useState(false)
  const status = getSessionStatus(item)

  const handleSelect = (state: import("@/config/session-status-config").SessionStatusId) => {
    setOpen(false)
    ctx.onSessionStatusChange(item.id, state)
  }

  return (
    <Popover modal={true} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            // 16px glyph (spec §2.4) in a 24px button box (36px in the compact/touch shell), padded around
            // the glyph with a matching negative margin so the row's layout doesn't change
            needsAttention && "text-yellow-600 dark:text-yellow-400",
            "relative !size-6 -m-1 p-1 flex items-center justify-center rounded-full cursor-pointer",
            "@max-mobile/shell:!size-9 @max-mobile/shell:-m-2.5 @max-mobile/shell:p-2.5",
            "before:absolute before:inset-0 before:rounded-full before:content-[''] hover:before:bg-fill-hover",
            "[&>svg]:w-full [&>svg]:h-full [&>img]:w-full [&>img]:h-full [&>span]:text-label",
          )}
          style={needsAttention ? undefined : getStateIconStyle(status, ctx.sessionStatuses)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={needsAttention ? `${t("attention.needsYou")}. ${t("status.change")}` : t("status.change")}
          title={needsAttention ? attentionDescription || t("attention.needsYou") : undefined}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {needsAttention ? <Hand aria-hidden="true" /> : getStateIcon(status, ctx.sessionStatuses)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-0 shadow-none bg-transparent"
        align="start"
        side="bottom"
        sideOffset={4}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <SessionStatusMenu
          activeState={status}
          onSelect={handleSelect}
          states={ctx.sessionStatuses}
          isArchived={item.isArchived}
          onArchive={ctx.onArchive ? () => { setOpen(false); ctx.onArchive!(item.id) } : undefined}
          onUnarchive={ctx.onUnarchive ? () => { setOpen(false); ctx.onUnarchive!(item.id) } : undefined}
        />
      </PopoverContent>
    </Popover>
  )
}
