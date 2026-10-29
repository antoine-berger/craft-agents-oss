/** Questions exposed by session tools, separate from permission/approval decisions. */
export interface UserQuestion {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

export interface UserQuestionAnswer {
  selected: string[]
  text?: string
}

export interface UserQuestionResponse {
  cancelled?: boolean
  answers: UserQuestionAnswer[]
}

export interface PendingUserQuestion {
  requestId: string
  sessionId: string
  questions: UserQuestion[]
  createdAt: number
  /** Background-only questions can be skipped without stopping unrelated agents. */
  cancelAction?: 'stop' | 'skip'
}

/** Validate client answers against the actual request, never arbitrary option labels. */
export function validateQuestionResponse(questions: UserQuestion[], response: unknown): UserQuestionResponse {
  if (!response || typeof response !== 'object') throw new Error('Invalid question response')
  const value = response as Partial<UserQuestionResponse>
  if (value.cancelled === true) return { cancelled: true, answers: [] }
  if (!Array.isArray(value.answers) || value.answers.length !== questions.length) {
    throw new Error('Answer every question before submitting')
  }
  const answers = value.answers.map((answer, index) => {
    const question = questions[index]!
    if (!answer || !Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string')) {
      throw new Error('Invalid selected options')
    }
    const selected = [...new Set(answer.selected)]
    if (selected.length !== answer.selected.length || selected.some(label => !question.options.some(option => option.label === label))) {
      throw new Error('An answer contains an unknown option')
    }
    if (!question.multiSelect && selected.length > 1) throw new Error('Choose only one option')
    if (answer.text !== undefined && typeof answer.text !== 'string') throw new Error('Invalid written answer')
    const text = answer.text?.trim()
    if (text && text.length > 4000) throw new Error('Written answer is too long')
    if (!selected.length && !text) throw new Error('Answer every question before submitting')
    return { selected, ...(text ? { text } : {}) }
  })
  return { answers }
}
