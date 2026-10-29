import * as React from 'react'
import { ArrowUp, Check, ChevronLeft, ChevronRight, CircleAlert, X } from 'lucide-react'
import { Markdown } from '@craft-agent/ui/markdown'
import type { PendingUserQuestion, UserQuestionAnswer, UserQuestionResponse } from '@craft-agent/core/types'
import { validateQuestionResponse } from '@craft-agent/core/types'
import { cn } from '@/lib/utils'

export interface UserQuestionInput {
  request: PendingUserQuestion
  submitting?: boolean
  error?: string | null
}

export function UserQuestionRequest({ request, submitting, error, onResponse, interactive = true, unstyled = false }: UserQuestionInput & {
  onResponse: (response: { type: 'question'; response: UserQuestionResponse }) => void
  /** The measuring copy and unfocused panes must never register shortcuts. */
  interactive?: boolean
  unstyled?: boolean
}) {
  const root = React.useRef<HTMLFieldSetElement>(null)
  const other = React.useRef<HTMLTextAreaElement>(null)
  const [sendKey, setSendKey] = React.useState<'enter' | 'cmd-enter'>('enter')
  const [index, setIndex] = React.useState(0)
  const [answers, setAnswers] = React.useState<UserQuestionAnswer[]>(() => request.questions.map(() => ({ selected: [] })))
  const question = request.questions[index]!
  const answer = answers[index]!
  const isAnswered = (value: UserQuestionAnswer) => Boolean(value.selected.length || value.text?.trim())
  const canSubmit = answers.every(isAnswered) && !submitting
  const last = index === request.questions.length - 1
  const cancelLabel = request.cancelAction === 'skip' ? 'Skip questions' : 'Cancel agent'
  const update = (next: UserQuestionAnswer) => setAnswers(values => values.map((value, i) => i === index ? next : value))
  const pickOption = (label: string) => {
    root.current?.focus({ preventScroll: true })
    const selected = question.multiSelect
      ? answer.selected.includes(label) ? answer.selected.filter(value => value !== label) : [...answer.selected, label]
      : [label]
    update({ selected, text: question.multiSelect ? answer.text : undefined })
    if (!question.multiSelect && !last) setIndex(index + 1)
  }
  const writeAnswer = (text: string) => update({
    selected: !question.multiSelect && text.trim() ? [] : answer.selected,
    text,
  })
  const submit = () => {
    if (canSubmit) onResponse({ type: 'question', response: validateQuestionResponse(request.questions, { answers }) })
  }
  const cancel = () => {
    if (!submitting) onResponse({ type: 'question', response: { cancelled: true, answers: [] } })
  }
  const advance = () => { if (last) submit(); else setIndex(index + 1) }

  React.useEffect(() => {
    let active = true
    void window.electronAPI?.getSendMessageKey?.().then(value => { if (active) setSendKey(value ?? 'enter') }).catch(() => {})
    return () => { active = false }
  }, [])

  React.useEffect(() => {
    if (!interactive || submitting) return
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target as HTMLElement | null
      const textInput = target?.matches?.('input, textarea, select') || target?.isContentEditable
      // A focused editor elsewhere (another pane, search, dialog) owns its keyboard.
      if (textInput && !root.current?.contains(target)) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); cancel(); return
      }
      const send = event.key === 'Enter' && !event.shiftKey && !event.altKey
        && (sendKey === 'cmd-enter' ? event.metaKey || event.ctrlKey : !event.metaKey && !event.ctrlKey)
      if (send) {
        event.preventDefault(); event.stopPropagation(); advance(); return
      }
      if (textInput || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation()
        setIndex(value => Math.max(0, Math.min(request.questions.length - 1, value + (event.key === 'ArrowLeft' ? -1 : 1))))
      } else if (event.key === '0') {
        event.preventDefault(); event.stopPropagation(); other.current?.focus()
      } else if (/^[1-9]$/.test(event.key)) {
        const option = question.options[Number(event.key) - 1]
        if (option) { event.preventDefault(); event.stopPropagation(); pickOption(option.label) }
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })

  return <fieldset ref={root} tabIndex={-1} disabled={submitting} aria-label="Questions from the agent"
    className={cn('flex max-h-full min-h-0 min-w-0 flex-col overflow-hidden px-3 py-3 outline-none', !unstyled && 'mb-2 w-full rounded-2xl border border-subtle bg-background')}>
    <div className="flex shrink-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        {question.header && <div className="mb-1 text-xs text-secondary">{question.header}</div>}
        <Markdown mode="chat" className="max-h-[45vh] overflow-y-auto text-sm">{question.question}</Markdown>
      </div>
      <button type="button" aria-label={cancelLabel} title={cancelLabel} onClick={cancel}
        className="shrink-0 text-secondary transition-colors hover:text-foreground"><X className="size-4" /></button>
    </div>
    <div className="mt-3 flex min-h-0 flex-col gap-0.5 overflow-y-auto" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
      {question.options.map((option, optionIndex) => {
        const selected = answer.selected.includes(option.label)
        return <button key={option.label} type="button" role={question.multiSelect ? 'checkbox' : 'radio'} aria-checked={selected}
          onClick={() => pickOption(option.label)}
          className={cn('flex items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors', selected ? 'bg-hover' : 'hover:bg-hover')}>
          <span className="mt-0.5 w-4 shrink-0 text-xs text-secondary">{optionIndex + 1}</span>
          <span className="min-w-0 flex-1"><span className="text-sm">{option.label}</span>{option.description && <span className="mt-0.5 block text-xs text-secondary">{option.description}</span>}</span>
          {question.multiSelect && selected && <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-secondary" />}
        </button>
      })}
      <div className={cn('flex items-start gap-2 rounded-sm px-2 py-1.5 transition-colors', answer.text?.trim() && 'bg-hover')}>
        <span className="mt-0.5 w-4 shrink-0 text-xs text-secondary">0</span>
        <textarea ref={other} aria-label="Other response" rows={1} value={answer.text ?? ''} maxLength={4000} onChange={event => writeAnswer(event.target.value)}
          autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="Other…"
          className="min-h-5 min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent p-0 text-sm leading-5 shadow-none outline-none placeholder:text-secondary focus:ring-0" />
        {question.multiSelect && <input type="checkbox" aria-label="Select other response" checked={Boolean(answer.text?.trim())} onChange={() => writeAnswer('')} className="mt-0.5 size-4 shrink-0 accent-foreground" />}
      </div>
    </div>
    {error && <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-destructive"><CircleAlert className="mt-0.5 size-3 shrink-0" />{error}</p>}
    <div className="mt-3 flex shrink-0 items-center justify-between">
      {request.questions.length > 1 ? <div className="flex items-center gap-1.5" aria-label="Question progress">
        <button type="button" disabled={!index || submitting} aria-label="Previous question" onClick={() => setIndex(index - 1)} className="rounded p-1 text-secondary hover:text-foreground disabled:opacity-30"><ChevronLeft className="size-3" /></button>
        {request.questions.map((item, i) => <button key={i} type="button" disabled={submitting} aria-label={`Question ${i + 1}`} aria-current={i === index ? 'step' : undefined} onClick={() => setIndex(i)} className={cn('size-2 rounded-full transition-colors hover:opacity-70', isAnswered(answers[i]!) ? 'bg-foreground' : 'border border-secondary bg-transparent', i === index && 'ring-1 ring-secondary ring-offset-1 ring-offset-background')} />)}
        <button type="button" disabled={last || submitting} aria-label="Next question" onClick={() => setIndex(index + 1)} className="rounded p-1 text-secondary hover:text-foreground disabled:opacity-30"><ChevronRight className="size-3" /></button>
      </div> : <div />}
      <button type="button" aria-label="Submit answers" title="Submit" disabled={!canSubmit} onClick={submit} className="flex size-7 items-center justify-center rounded-md bg-foreground text-background hover:bg-foreground/80 disabled:cursor-not-allowed disabled:bg-foreground/50"><ArrowUp className="size-4" style={{ strokeWidth: 1.5 }} /></button>
    </div>
  </fieldset>
}
