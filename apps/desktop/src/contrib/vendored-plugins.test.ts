import { beforeAll, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'

import type { HermesPlugin } from './plugin'
import { discoverBundledPlugins } from './plugins'
import { $pluginDecisions, $pluginRecords, setPluginEnabled } from './plugins-store'

vi.mock('./runtime-loader', () => ({ watchRuntimePlugins: vi.fn() }))
// No agent has a gateway half here, so availability probes answer 404 and the plugins stay hidden.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof Hermes>()),
  pluginRest: vi.fn(() => Promise.reject(new Error('404: Not Found')))
}))

// Vendored builds (src/plugins/<name>/plugin.js) are copied byte for byte from their own repos, so nothing
// type-checks them against this app. The production build fails on any name they import that the SDK no longer
// exports; this covers the rest: each one is a valid plugin and registers through the real lifecycle without
// throwing.
const all = import.meta.glob<{ default: HermesPlugin }>('../plugins/*/plugin.{js,ts,tsx}', { eager: true })
const vendored = import.meta.glob<{ default: HermesPlugin }>('../plugins/*/plugin.js', { eager: true })

beforeAll(() => {
  $pluginDecisions.set(Object.fromEntries(Object.values(all).map(mod => [mod.default.id, false])))
  discoverBundledPlugins()
})

describe('vendored bundled plugins', () => {
  it('includes the vendored builds', () => {
    expect(Object.values(vendored).map(mod => mod.default.id)).toEqual(
      expect.arrayContaining(['fish-audio', 'hermes-cloud-file-manager'])
    )
  })

  it.each(Object.entries(vendored))('%s registers without error', async (_path, mod) => {
    const { id } = mod.default
    await setPluginEnabled(id, true)

    try {
      expect($pluginRecords.get()[id]).toMatchObject({ kind: 'bundled', status: 'loaded' })
    } finally {
      await setPluginEnabled(id, false)
    }
  })
})
