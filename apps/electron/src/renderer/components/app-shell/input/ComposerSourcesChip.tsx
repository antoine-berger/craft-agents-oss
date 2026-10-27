import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DatabaseZap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { SourceSelectorPopover } from '@/components/ui/SourceSelectorPopover'
import { CompactSourceSelector } from '@/components/ui/CompactSourceSelector'
import type { LoadedSource } from '../../../../shared/types'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'

interface ComposerSourcesChipProps {
  /** Compact/touch layout: bottom-sheet selector instead of the anchored popover */
  compact: boolean
  sources: LoadedSource[]
  /** Optimistic enabled source slugs (owned by FreeFormInput) */
  selectedSlugs: string[]
  onToggleSlug: (slug: string) => void
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  isEmptySession: boolean
  disabled: boolean
  buttonRef: React.RefObject<HTMLButtonElement>
  claudeAccountConnectors?: boolean
  managedConnectors?: LoadedSource[]
}

/** Up to three source marks on raised tiles with a hairline, then a "+N" tile. */
function SourceStack({ sources }: { sources: LoadedSource[] }) {
  const displaySources = sources.slice(0, 3)
  const remainingCount = sources.length - 3
  return (
    <div className="-ml-0.5 flex items-center">
      {displaySources.map((source, index) => (
        <div
          key={source.config.slug}
          className={cn('relative flex size-5 items-center justify-center rounded-xs bg-raised shadow-elev-0', index > 0 && '-ml-1')}
          style={{ zIndex: index + 1 }}
        >
          <SourceAvatar source={source} size="xs" />
        </div>
      ))}
      {remainingCount > 0 && (
        <div
          className="-ml-1 flex size-5 items-center justify-center rounded-xs bg-raised text-caption text-tertiary shadow-elev-0 tabular-nums"
          style={{ zIndex: displaySources.length + 1 }}
        >
          +{remainingCount}
        </div>
      )}
    </div>
  )
}

/**
 * Sources chip in the composer toolbar (mockup "Sources 3" chip). Same labels, selectors and
 * toggling as before; desktop anchors SourceSelectorPopover, compact opens CompactSourceSelector.
 */
export function ComposerSourcesChip({
  compact,
  sources,
  selectedSlugs,
  onToggleSlug,
  open,
  setOpen,
  isEmptySession,
  disabled,
  buttonRef,
  claudeAccountConnectors = false,
  managedConnectors,
}: ComposerSourcesChipProps) {
  const { t } = useTranslation()
  const enabledSources = sources.filter(s => selectedSlugs.includes(s.config.slug))

  const icon = selectedSlugs.length === 0
    ? <DatabaseZap className="h-4 w-4" />
    : <SourceStack sources={enabledSources} />

  if (compact) {
    return (
      <div className="relative min-w-0 shrink">
        <FreeFormInputContextBadge
          buttonRef={buttonRef}
          icon={icon}
          label={
            selectedSlugs.length === 0
              ? claudeAccountConnectors ? t('chat.claudeConnectors.label') : t("chat.sourcesTooltip")
              : enabledSources.length === 1
                ? enabledSources[0].config.name
                : t("chat.sourcesCount", { count: enabledSources.length })
          }
          isExpanded={false}
          hasSelection={selectedSlugs.length > 0}
          showChevron={false}
          isOpen={open}
          disabled={disabled}
          onClick={() => setOpen(prev => !prev)}
          tooltip={t("chat.sourcesTooltip")}
        />
        <CompactSourceSelector
          open={open}
          onOpenChange={setOpen}
          sources={sources}
          selectedSlugs={selectedSlugs}
          onToggleSlug={onToggleSlug}
          claudeAccountConnectors={claudeAccountConnectors}
          managedConnectors={managedConnectors}
        />
      </div>
    )
  }

  return (
    <div className="relative min-w-0 shrink overflow-hidden">
      <FreeFormInputContextBadge
        buttonRef={buttonRef}
        icon={icon}
        label={
          selectedSlugs.length === 0
            ? claudeAccountConnectors ? t('chat.claudeConnectors.label') : t("chat.chooseSources")
            : enabledSources.length === 1
              ? enabledSources[0].config.name
              : enabledSources.length === 2
                ? enabledSources.map(s => s.config.name).join(', ')
                : t("chat.sourcesCount", { count: enabledSources.length })
        }
        isExpanded={isEmptySession}
        hasSelection={selectedSlugs.length > 0}
        showChevron={true}
        isOpen={open}
        disabled={disabled}
        data-tutorial="source-selector-button"
        onClick={() => setOpen(prev => !prev)}
        tooltip={t("chat.sourcesTooltip")}
      />

      <SourceSelectorPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        sources={sources}
        selectedSlugs={selectedSlugs}
        onToggleSlug={onToggleSlug}
        claudeAccountConnectors={claudeAccountConnectors}
        managedConnectors={managedConnectors}
      />
    </div>
  )
}
