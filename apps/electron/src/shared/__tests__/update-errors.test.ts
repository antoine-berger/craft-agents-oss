import { expect, test } from 'bun:test'
import { serverUpdateError, updateErrorMessage } from '../update-errors'
test('busy refusals are understandable and contain no SSH command', () => {
  const error=serverUpdateError({message:'Command failed: ssh root@host apply',stderr:'{"code":"server_busy","error":"Active sessions"}\n'})
  expect(error.name).toBe('ServerUpdateBusy');expect(error.message).toContain('Serveur occupé');expect(error.message).not.toContain('ssh')
})
test('old helper busy responses remain compatible', () => {
  expect(serverUpdateError({stderr:'{"error":"A session is active or the idle check failed; restart refused"}'}).name).toBe('ServerUpdateBusy')
})
test('real helper failures stay distinct from a busy server', () => {
  const e=serverUpdateError({stderr:'{"code":"update_failed","error":"Impossible de vérifier la connexion"}'})
  expect(e.name).toBe('Error');expect(e.message).toBe('Impossible de vérifier la connexion')
})
test('renderer omits Electron RPC wrapping', () => {
  expect(updateErrorMessage(new Error("Error invoking remote method 'update:install': Error: Espace disque insuffisant"))).toBe('Espace disque insuffisant')
})
