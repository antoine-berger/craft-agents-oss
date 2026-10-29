import { expect, it, mock } from 'bun:test'
import { sendMessageUntilAck } from './message-ack'

it('returns a durable receipt while the model turn remains pending', async () => {
  let finish!: () => void
  const turn = new Promise<void>(resolve => { finish = resolve })
  const late = mock(() => {})
  const receipt = await sendMessageUntilAck(ack => { ack('persisted'); return turn }, late)
  expect(receipt).toEqual({ accepted: true, messageId: 'persisted' })
  expect(late).not.toHaveBeenCalled()
  finish()
})
it('does not acknowledge before persistence and propagates pre-receipt failures', async () => {
  let reject!: (error: Error) => void, returned = false
  const result = sendMessageUntilAck(() => new Promise((_resolve, no) => { reject = no }), () => {})
  result.then(() => { returned = true }, () => {})
  await Promise.resolve(); expect(returned).toBe(false)
  reject(new Error('disk failed'))
  await expect(result).rejects.toThrow('disk failed')
})
it('reports post-receipt errors separately without retracting an accepted send', async () => {
  const late = mock(() => {})
  const result = await sendMessageUntilAck(ack => { ack('once'); ack('twice'); return Promise.reject(new Error('provider failed')) }, late)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(result.messageId).toBe('once'); expect(late).toHaveBeenCalledTimes(1)
})
it('rejects a missing receipt or a synchronous send failure', async () => {
  await expect(sendMessageUntilAck(async () => {}, () => {})).rejects.toThrow('without persisting')
  await expect(sendMessageUntilAck(() => { throw Error('bad target') }, () => {})).rejects.toThrow('bad target')
})
