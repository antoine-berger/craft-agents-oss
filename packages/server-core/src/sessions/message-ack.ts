/** Resolve at durable receipt, while the destination's model turn continues. */
export function sendMessageUntilAck(
  send: (ack: (messageId: string) => void) => Promise<void>,
  onLateError: (error: unknown) => void,
): Promise<{ accepted: true; messageId: string }> {
  return new Promise((resolve, reject) => {
    let acked = false
    const ack = (messageId: string) => {
      if (acked) return
      acked = true
      resolve({ accepted: true, messageId })
    }
    send(ack).then(() => {
      if (!acked) reject(new Error('sendMessage completed without persisting a user message'))
    }).catch(error => {
      if (!acked) reject(error)
      else onLateError(error)
    })
  })
}
