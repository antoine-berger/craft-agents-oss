import { useTranslation } from 'react-i18next'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const SEND_BASE = 'send-btn shrink-0 rounded-full enabled:active:[transform:scale(calc(1_-_0.06*var(--motion-scale)))]'

interface SendButtonProps {
  isProcessing: boolean
  /** Send is not possible (no content, disabled input or tutorial gate). */
  disabled: boolean
  onStop: () => void
  /** A running chat can still send its draft through the existing submission handler. */
  appearance?: 'default' | 'chat'
}

export function SendButton({ isProcessing, disabled, onStop, appearance = 'default' }: SendButtonProps) {
  const { t } = useTranslation()
  const isChat = appearance === 'chat'
  const showSend = !isProcessing || (isChat && !disabled)
  const primaryClass = isChat ? 'bg-foreground text-[var(--surface-paper)] hover:bg-foreground/80 disabled:bg-foreground/50 disabled:text-[var(--surface-paper)]' : undefined

  return (
    <>
      {isProcessing && (
        <Button
          type="button"
          variant={showSend || isChat ? 'ghost' : 'primary'}
          size="icon"
          aria-label={t('chat.stopResponse')}
          data-state="stop"
          className={cn(SEND_BASE, showSend ? 'border border-strong bg-paper' : primaryClass)}
          onClick={onStop}
        >
          <Square className="size-2.5 fill-current" />
        </Button>
      )}
      {showSend && (
        <Button
          type="submit"
          variant={isChat ? 'ghost' : 'primary'}
          size="icon"
          aria-label={t('shortcuts.sendMessage')}
          data-state={disabled ? 'idle' : 'ready'}
          className={cn(SEND_BASE, primaryClass)}
          disabled={disabled}
          data-tutorial="send-button"
        >
          <ArrowUp className="size-4" strokeWidth={isChat ? 1.5 : 2} />
        </Button>
      )}
    </>
  )
}
