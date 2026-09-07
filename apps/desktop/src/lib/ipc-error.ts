// Electron reports a rejected `ipcMain.handle` to the renderer as
// "Error invoking remote method 'hermes:api': EvaBrokerError: <message>". The
// prefix names an IPC channel and a main-process class the operator cannot
// act on, and it leaked into the boot-failure error box (adapter#91). Keep only
// the message the main process chose.
const IPC_ERROR_PREFIX_RE = /^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/

export function stripIpcErrorPrefix(message: string): string {
  const stripped = message.replace(IPC_ERROR_PREFIX_RE, '').trim()

  return stripped || message
}
