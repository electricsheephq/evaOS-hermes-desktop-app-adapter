const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback, transform = payload => payload) {
  const listener = (_event, payload) => callback(transform(payload))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Managed Eva exposes only the remote-agent transport, session lifecycle, and
// ordinary window/UI helpers. Local shell, filesystem, Git, terminal,
// bootstrap, arbitrary URL, updater mutation, marketplace, and uninstall IPC
// are intentionally absent.
const managedBridge = {
  getConnection: profile => ipcRenderer.invoke('hermes:connection', profile),
  revalidateConnection: () => ipcRenderer.invoke('hermes:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('hermes:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('hermes:gateway:ws-url', profile),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('hermes:window:openSession', sessionId, opts),
  openNewSessionWindow: () => ipcRenderer.invoke('hermes:window:openNewSession'),
  eva: {
    status: () => ipcRenderer.invoke('hermes:eva:status'),
    signIn: () => ipcRenderer.invoke('hermes:eva:sign-in'),
    signOut: () => ipcRenderer.invoke('hermes:eva:sign-out'),
    refresh: () => ipcRenderer.invoke('hermes:eva:refresh')
  },
  profile: {
    get: () => ipcRenderer.invoke('hermes:profile:get')
  },
  api: request => ipcRenderer.invoke('hermes:api', request),
  notify: payload => ipcRenderer.invoke('hermes:notify', payload),
  writeClipboard: text => ipcRenderer.invoke('hermes:writeClipboard', text),
  openExternal: url => ipcRenderer.invoke('hermes:openExternal', url),
  setTitleBarTheme: payload => ipcRenderer.send('hermes:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('hermes:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('hermes:translucency', payload),
  setPreviewShortcutActive: active => ipcRenderer.send('hermes:previewShortcutActive', Boolean(active)),
  zoom: {
    get: () => ipcRenderer.invoke('hermes:zoom:get'),
    setPercent: percent => ipcRenderer.send('hermes:zoom:set-percent', percent),
    onChanged: callback => subscribe('hermes:zoom:changed', callback)
  },
  petOverlay: {
    open: request => ipcRenderer.invoke('hermes:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('hermes:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('hermes:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('hermes:pet-overlay:ignore-mouse', ignore),
    setFocusable: focusable => ipcRenderer.send('hermes:pet-overlay:set-focusable', focusable),
    pushState: payload => ipcRenderer.send('hermes:pet-overlay:state', payload),
    control: payload => ipcRenderer.send('hermes:pet-overlay:control', payload),
    onState: callback => subscribe('hermes:pet-overlay:state', callback),
    onControl: callback => subscribe('hermes:pet-overlay:control', callback)
  },
  getBootProgress: () => ipcRenderer.invoke('hermes:boot-progress:get'),
  getVersion: () => ipcRenderer.invoke('hermes:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('hermes:get-remote-display-reason'),
  updates: {
    check: () => ipcRenderer.invoke('hermes:updates:check'),
    getBranch: () => ipcRenderer.invoke('hermes:updates:branch:get'),
    onProgress: callback => subscribe('hermes:updates:progress', callback)
  },
  onClosePreviewRequested: callback => subscribe('hermes:close-preview-requested', callback),
  onOpenUpdatesRequested: callback => subscribe('hermes:open-updates', callback),
  onWindowStateChanged: callback => subscribe('hermes:window-state-changed', callback),
  onFocusSession: callback => subscribe('hermes:focus-session', callback),
  onNotificationAction: callback => subscribe('hermes:notification-action', callback),
  onBackendExit: callback => subscribe('hermes:backend-exit', callback),
  onPowerResume: callback => subscribe('hermes:power-resume', callback),
  onBootProgress: callback => subscribe('hermes:boot-progress', callback)
}

contextBridge.exposeInMainWorld('hermesDesktop', managedBridge)
