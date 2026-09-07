// "Switch Support Target…" needs a home in the native menu on every managed
// platform: on macOS in the application menu, where an app-level recovery
// action belongs, and in the File menu everywhere else, because Windows and
// Linux have no application menu to put it in. `buildApplicationMenu()` lives
// in main.ts and cannot run outside a live Electron app, so the placement is a
// pure helper — that is the seam both platforms are actually tested through.
export type SupportTargetMenuEntry = Record<string, unknown>

export function supportTargetMenuPlacement<T extends SupportTargetMenuEntry>(
  item: T,
  options: { isMac: boolean; managed: boolean }
): { appMenu: (T | { type: string })[]; fileMenu: (T | { type: string })[] } {
  if (!options.managed) {
    return { appMenu: [], fileMenu: [] }
  }

  return options.isMac
    ? { appMenu: [item, { type: 'separator' }], fileMenu: [] }
    : { appMenu: [], fileMenu: [item, { type: 'separator' }] }
}
