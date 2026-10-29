import { describe, expect, it, spyOn } from 'bun:test'
import { SessionQuestions } from './session-questions'
import { validateQuestionResponse } from '@craft-agent/core/types'

const questions = [{ question: 'Choose a target', options: [{ label: 'Current project' }, { label: 'Another project' }] }]

describe('interactive session questions', () => {
  it('returns the actual answer to its awaiting tool and rejects a stale second response', async () => {
    const changes: unknown[] = []
    const service = new SessionQuestions((sid, request) => changes.push([sid, request]))
    const result = service.ask('one', questions)
    const request = service.get('one')!
    expect(request.questions).toEqual(questions)
    expect(service.answer('one', request.requestId, { answers: [{ selected: ['Current project'] }] })).toBe(true)
    expect(await result).toEqual({ answers: [{ selected: ['Current project'] }] })
    expect(service.get('one')).toBeNull()
    expect(() => service.answer('one', request.requestId, { answers: [] })).toThrow('no longer pending')
    expect(changes).toHaveLength(2)
  })

  it('does not consume a request on invalid answers or a different session/request identity', async () => {
    const service = new SessionQuestions(() => {})
    const result = service.ask('one', questions)
    const request = service.get('one')!
    expect(() => service.answer('other', request.requestId, { answers: [] })).toThrow()
    expect(() => service.answer('one', 'old', { answers: [] })).toThrow()
    expect(() => service.answer('one', request.requestId, { answers: [{ selected: ['Injected option'] }] })).toThrow('unknown option')
    expect(service.get('one')?.requestId).toBe(request.requestId)
    service.answer('one', request.requestId, { cancelled: true, answers: [] })
    expect(await result).toEqual({ cancelled: true, answers: [] })
  })

  it('cancels only the stopped session and leaves no request to recover after a server restart', async () => {
    const service = new SessionQuestions(() => {})
    const first = service.ask('one', questions)
    const second = service.ask('two', questions)
    const stopped = first.catch(error => error as Error)
    service.cancel('one', 'This chat was archived')
    expect(((await stopped) as Error).message).toContain('archived')
    expect(service.get('one')).toBeNull()
    expect(service.get('two')).not.toBeNull()
    const closed = second.catch(error => error as Error)
    service.dispose()
    expect(((await closed) as Error).message).toContain('shutting down')
    expect(new SessionQuestions(() => {}).get('two')).toBeNull()
  })

  it('settles awaits and snapshots even when publishing state throws', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const service = new SessionQuestions(() => { throw new Error('Transport disconnected') })
      const answered = service.ask('one', questions)
      service.answer('one', service.get('one')!.requestId, { answers: [{ selected: ['Current project'] }] })
      expect((await answered).answers[0]?.selected).toEqual(['Current project'])
      expect(service.get('one')).toBeNull()
      const cancelled = service.ask('two', questions).catch(error => error as Error)
      service.cancel('two', 'Stopped')
      expect(((await cancelled) as Error).message).toBe('Stopped')
      expect(service.get('two')).toBeNull()
      expect(log).toHaveBeenCalledTimes(4)
    } finally { log.mockRestore() }
  })

  it('binds cancellation to its own invocation and releases old signal handlers', async () => {
    const service = new SessionQuestions(() => {})
    const firstSignal = new AbortController()
    const otherSignal = new AbortController()
    const first = service.ask('one', questions, firstSignal.signal)
    otherSignal.abort()
    expect(service.get('one')).not.toBeNull()
    service.answer('one', service.get('one')!.requestId, { answers: [{ selected: ['Current project'] }] })
    await first
    const second = service.ask('one', questions).catch(error => error as Error)
    firstSignal.abort()
    expect(service.get('one')).not.toBeNull()
    service.cancel('one', 'Owner stopped')
    expect(((await second) as Error).message).toBe('Owner stopped')
    const cancelled = service.ask('two', questions, new AbortController().signal)
    const failed = cancelled.catch(error => error as Error)
    service.cancel('two', 'Archived')
    expect(((await failed) as Error).message).toBe('Archived')
    const controller = new AbortController()
    const current = service.ask('one', questions, controller.signal).catch(error => error as Error)
    controller.abort()
    expect(((await current) as Error).message).toContain('question tool was cancelled')
    expect(service.get('one')).toBeNull()
  })

  it('does not fabricate an answer when another question is already waiting', async () => {
    const service = new SessionQuestions(() => {})
    const first = service.ask('one', questions)
    await expect(service.ask('one', questions)).rejects.toThrow('already has questions')
    service.answer('one', service.get('one')!.requestId, { answers: [{ selected: [], text: 'A written answer' }] })
    expect((await first).answers[0]?.text).toBe('A written answer')
  })
})

describe('question answer validation', () => {
  it('validates multiselect, free text, completeness and duplicate options against the request', () => {
    expect(() => validateQuestionResponse(questions, { answers: [{ selected: ['Current project', 'Another project'] }] })).toThrow('only one')
    expect(() => validateQuestionResponse(questions, { answers: [] })).toThrow('every question')
    expect(() => validateQuestionResponse(questions, { answers: [{ selected: [] }] })).toThrow('every question')
    expect(() => validateQuestionResponse(questions, { answers: [{ selected: ['Current project', 'Current project'] }] })).toThrow('unknown option')
    expect(validateQuestionResponse([{ ...questions[0]!, multiSelect: true }], { answers: [{ selected: ['Current project', 'Another project'], text: '  details  ' }] })).toEqual({ answers: [{ selected: ['Current project', 'Another project'], text: 'details' }] })
  })
})
