// "Switch Support Target…" needs a home in the native menu on every managed
// platform: on macOS in the application menu, where an app-level recovery
// action belongs, and in the File menu everywhere else, because Windows and
// Linux have no application menu to put it in. `buildApplicationMenu()` lives
// in main.ts and cannot run outside a live Electron app, so the placement is a
// pure helper — that is the seam both platforms are actually tested through.
export type SupportTargetMenuEntry = Record<string, unknown>

export function switchSupportTargetMenuItem(deps: {
  switchSupportTarget: () => Promise<unknown>
  openPicker: () => void
  log: (line: string) => void
}) {
  return {
    label: 'Switch Support Target…',
    click: () => {
      void deps
        .switchSupportTarget()
        .then(deps.openPicker)
        .catch(error => {
          // Bounded machine code only — broker prose may carry private detail.
          const code = String(error?.code || '').match(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/)?.[0]
          deps.log(`[eva-support] switch support target rejected: ${code || 'switch-target-failed'}`)
        })
    }
  }
}

export function supportTargetMenuPlacement<T extends SupportTargetMenuEntry>(
  item: T,
  options: { isMac: boolean; managed: boolean }
): { appMenu: (T | { type: 'separator' })[]; fileMenu: (T | { type: 'separator' })[] } {
  if (!options.managed) {
    return { appMenu: [], fileMenu: [] }
  }

  return options.isMac
    ? { appMenu: [item, { type: 'separator' }], fileMenu: [] }
    : { appMenu: [], fileMenu: [item, { type: 'separator' }] }
}
