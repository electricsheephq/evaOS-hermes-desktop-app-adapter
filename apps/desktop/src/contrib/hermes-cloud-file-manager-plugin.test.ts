import { ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'

import { discoverBundledPlugins } from './plugins'
import { $pluginDecisions, $pluginRecords, setPluginEnabled } from './plugins-store'
import { registry } from './registry'

const rest = vi.hoisted(() => vi.fn())

vi.mock('./runtime-loader', () => ({ watchRuntimePlugins: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({ ...(await importOriginal<typeof Hermes>()), pluginRest: rest }))

const ID = 'hermes-cloud-file-manager'
const fromCloud = (area: string) => registry.getArea(area).filter(item => item.source === `plugin:${ID}`)

afterEach(async () => {
  await setPluginEnabled(ID, false)
  vi.restoreAllMocks()
})

describe('bundled Cloud File Manager plugin', () => {
  it('finds the download capture it looks up on the SDK namespace', async () => {
    // The plugin reads captureGatewayFileDownload off `import * as sdk`, so a rename would hide Download silently.
    const sdk: Record<string, unknown> = await import('@hermes/plugin-sdk')

    expect(typeof sdk.captureGatewayFileDownload).toBe('function')
  })

  it('loads by default and shows its sidebar row only once the agent gateway answers /available', async () => {
    let answer: (value: unknown) => void = () => {}
    rest.mockImplementation((_id: string, path: string) =>
      path === '/available' ? new Promise(resolve => (answer = resolve)) : Promise.reject(new Error('404: Not Found'))
    )
    // Other bundled plugins are outside this test; Cloud File Manager has no saved decision.
    $pluginDecisions.set({ accent: false, kanban: false, 'hermes-bots': false, 'fish-audio': false })

    discoverBundledPlugins()
    expect($pluginRecords.get()[ID]).toMatchObject({ kind: 'bundled', status: 'loaded' })
    // The route is always registered, so a restored Cloud Files tab never falls through to the session route.
    expect(fromCloud(ROUTES_AREA)).toHaveLength(1)
    // An agent without the gateway half shows nothing until /available answers.
    expect(fromCloud(SIDEBAR_NAV_AREA)).toHaveLength(0)
    expect(rest).toHaveBeenCalledWith(ID, '/available', undefined)

    answer({ ok: true, plugin: ID, version: '0.3.5' })
    await vi.waitFor(() => expect(fromCloud(SIDEBAR_NAV_AREA)).toHaveLength(1))
  })

  it('removes its sidebar row when a new agent answers /available with 404', async () => {
    const session = await import('@/store/session')

    let first = true
    rest.mockImplementation((_id: string, path: string) => {
      if (path === '/available' && first) {
        first = false

        return Promise.resolve({ ok: true, plugin: ID, version: '0.3.5' })
      }

      return Promise.reject(new Error('404: Not Found'))
    })
    $pluginDecisions.set({ accent: false, kanban: false, 'hermes-bots': false, 'fish-audio': false })
    discoverBundledPlugins()
    await setPluginEnabled(ID, true)
    await vi.waitFor(() => expect(fromCloud(SIDEBAR_NAV_AREA)).toHaveLength(1))

    // An agent without the gateway half must not keep the previous agent's Cloud Files row.
    session.setConnection({ connectionId: 'agent-b', mode: 'remote' } as never)
    await vi.waitFor(() => expect(fromCloud(SIDEBAR_NAV_AREA)).toHaveLength(0))
    session.setConnection(null)
  })
})
