/** Keep subprocess commands and Electron's RPC wrapper out of user-facing update errors. */
export function updateErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}
export function serverUpdateError(error: unknown): Error {
  const record = error as { stderr?: unknown }
  let message = 'La commande de mise à jour du serveur a échoué.'
  let code = ''
  if (typeof record?.stderr === 'string') {
    for (const line of record.stderr.trim().split('\n').reverse()) {
      try {
        const payload = JSON.parse(line)
        if (typeof payload.error === 'string') { message = payload.error; code = payload.code ?? ''; break }
      } catch { /* SSH can prefix a diagnostic before the helper's JSON error. */ }
    }
  }
  const busy = code === 'server_busy' || /A session is active|An agent or command still has a process/.test(message)
  const result = new Error(busy ? 'Serveur occupé : attends la fin des agents et commandes avant de réessayer. Aucun redémarrage effectué.' : message)
  if (busy) result.name = 'ServerUpdateBusy'
  return result
}
