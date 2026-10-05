import { ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'

import { discoverBundledPlugins } from './plugins'
import { $pluginDecisions, $pluginRecords, setPluginEnabled } from './plugins-store'
import { registry } from './registry'

const rest = vi.hoisted(() => vi.fn())

vi.mock('./runtime-loader', () => ({ watchRuntimePlugins: vi.fn() }))
vi.mock('@/hermes', async importOriginal => ({ ...(await importOriginal<typeof Hermes>()), pluginRest: rest }))

const fromFish = (area: string) => registry.getArea(area).filter(item => item.source === 'plugin:fish-audio')

afterEach(async () => {
  await setPluginEnabled('fish-audio', false)
  vi.restoreAllMocks()
})

describe('bundled Fish Audio plugin', () => {
  it('loads by default and shows its sidebar row only once the agent gateway answers /available', async () => {
    let answer: (value: unknown) => void = () => {}
    rest.mockImplementation((_id: string, path: string) =>
      path === '/available' ? new Promise(resolve => (answer = resolve)) : Promise.resolve({ ok: false })
    )
    // Other bundled plugins are outside this test; Fish Audio has no saved decision.
    $pluginDecisions.set({ accent: false, kanban: false, 'hermes-bots': false })

    discoverBundledPlugins()
    expect($pluginRecords.get()['fish-audio']).toMatchObject({ kind: 'bundled', status: 'loaded' })
    // The route is always registered, so a restored Voices tab never falls through to the session route.
    expect(fromFish(ROUTES_AREA)).toHaveLength(1)
    // An agent without the gateway half shows nothing until /available answers.
    expect(fromFish(SIDEBAR_NAV_AREA)).toHaveLength(0)
    expect(rest).toHaveBeenCalledWith('fish-audio', '/available', undefined)

    answer({ ok: true, key: true, version: '1.0.1' })
    await vi.waitFor(() => expect(fromFish(SIDEBAR_NAV_AREA)).toHaveLength(1))
  })

  it('hides its sidebar row at once on an agent switch, until the new agent answers', async () => {
    const session = await import('@/store/session')

    let answer: (value: unknown) => void = () => {}
    let first = true
    rest.mockImplementation((_id: string, path: string) => {
      if (path !== '/available') {
        return Promise.resolve({ ok: false })
      }

      if (first) {
        first = false

        return Promise.resolve({ ok: true, key: true, version: '1.0.2' })
      }

      return new Promise(resolve => (answer = resolve))
    })
    discoverBundledPlugins()
    await setPluginEnabled('fish-audio', true)
    await vi.waitFor(() => expect(fromFish(SIDEBAR_NAV_AREA)).toHaveLength(1))

    // An agent without the gateway half must not inherit the previous agent's Voices row.
    session.setConnection({ connectionId: 'agent-b', mode: 'remote' } as never)
    expect(fromFish(SIDEBAR_NAV_AREA)).toHaveLength(0)

    answer({ ok: true, key: true, version: '1.0.2' })
    await vi.waitFor(() => expect(fromFish(SIDEBAR_NAV_AREA)).toHaveLength(1))
    session.setConnection(null)
  })
})
