import { CAPABILITIES_ROUTE } from '../routes'

const MOVED_TO_CAPABILITIES: Record<string, { param: string; tab: string }> = {
  mcp: { param: 'server', tab: 'connectors' },
  plugins: { param: 'plugin', tab: 'plugins' }
}

/** Capabilities ▸ Plugins param that opens an agent plugin's inline settings form (see plugins-tab.tsx). */
export const PLUGIN_SETTINGS_PARAM = 'settings'

export function movedSettingsTabRedirect(search: string): null | string {
  const params = new URLSearchParams(search)
  const tab = params.get('tab') ?? ''
  const moved = MOVED_TO_CAPABILITIES[tab]

  if (moved === undefined) {
    return null
  }

  // Upstream links name an agent plugin's settings form with `agent=<key>`
  // (Settings ▸ Plugins ▸ <plugin> ▸ Agent settings). Here that form sits
  // under the plugin's row, so highlight the row and open the form.
  const agent = tab === 'plugins' ? params.get('agent') : null
  const row = params.get(moved.param) ?? agent
  const suffix = row ? `&${moved.param}=${encodeURIComponent(row)}` : ''
  const open = agent ? `&${PLUGIN_SETTINGS_PARAM}=${encodeURIComponent(agent)}` : ''

  return `${CAPABILITIES_ROUTE}?tab=${moved.tab}${suffix}${open}`
}
