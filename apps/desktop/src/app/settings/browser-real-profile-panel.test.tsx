// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { BrowserRealProfilePanel } from './browser-real-profile-panel'

const mocks = vi.hoisted(() => ({
  cache: vi.fn(),
  loadedConfig: {} as Record<string, unknown>,
  notify: vi.fn(),
  notifyError: vi.fn(),
  save: vi.fn()
}))

vi.mock('@/hermes', () => ({
  saveHermesConfigRecord: (config: Record<string, unknown>, profile?: unknown) => mocks.save(config, profile)
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      settings: {
        toolsets: {
          browserRealProfile: {
            label: 'Use My Real Browser Profile',
            description: 'Copies your default browser profile into a managed snapshot.',
            remoteDescription: 'Available only when this profile uses the local runtime.',
            enabledTitle: 'Real-profile browsing on',
            enabledMessage: 'New sessions use the snapshot.',
            disabledTitle: 'Real-profile browsing off',
            disabledMessage: 'Snapshot will be deleted.',
            failedSave: 'Could not save the real-profile setting'
          }
        }
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => mocks.notify(...args),
  notifyError: (...args: unknown[]) => mocks.notifyError(...args)
}))

vi.mock('../hooks/use-config-record', () => ({
  hermesConfigCacheWriter: () => (config: Record<string, unknown>) => mocks.cache(config),
  useHermesConfigRecord: () => ({ data: mocks.loadedConfig })
}))

describe('BrowserRealProfilePanel', () => {
  beforeEach(() => {
    $connection.set({ mode: 'local' } as NonNullable<ReturnType<typeof $connection.get>>)
    mocks.loadedConfig = { browser: { allow_private_urls: false }, model: { provider: 'nous' } }
    mocks.save.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders off for a config without the key and turns it on', async () => {
    render(<BrowserRealProfilePanel />)
    const toggle = screen.getByRole('switch', { name: 'Use My Real Browser Profile' })

    expect(toggle).toHaveProperty('ariaChecked', 'false')

    await act(async () => {
      fireEvent.click(toggle)
    })

    // Saves ONLY the toggled key (PUT deep-merges); the cache keeps the whole
    // merged record so sibling browser keys survive without a refetch.
    expect(mocks.save).toHaveBeenCalledWith({ browser: { use_real_profile: true } }, undefined)
    expect(mocks.cache).toHaveBeenCalledWith({
      browser: { allow_private_urls: false, use_real_profile: true },
      model: { provider: 'nous' }
    })
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('turns an enabled toggle off', async () => {
    mocks.loadedConfig = { browser: { use_real_profile: true } }
    render(<BrowserRealProfilePanel />)
    const toggle = screen.getByRole('switch', { name: 'Use My Real Browser Profile' })

    expect(toggle).toHaveProperty('ariaChecked', 'true')

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(mocks.save).toHaveBeenCalledWith({ browser: { use_real_profile: false } }, undefined)
  })

  it('rolls the optimistic cache write back when the save fails', async () => {
    mocks.save.mockRejectedValue(new Error('boom'))
    render(<BrowserRealProfilePanel />)

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Use My Real Browser Profile' }))
    })

    // Last cache write restores the original record.
    expect(mocks.cache).toHaveBeenLastCalledWith(mocks.loadedConfig)
    expect(mocks.notifyError).toHaveBeenCalled()
  })

  it('disables enabling for a remote managed profile', () => {
    $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
    render(<BrowserRealProfilePanel />)

    expect(screen.getByRole('switch', { name: 'Use My Real Browser Profile' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Available only when this profile uses the local runtime.')).toBeTruthy()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('fails closed while the connection mode is unresolved', () => {
    $connection.set(null)
    render(<BrowserRealProfilePanel />)

    const toggle = screen.getByRole('switch', { name: 'Use My Real Browser Profile' })
    expect(toggle).toHaveProperty('disabled', true)
    expect(screen.getByText('Copies your default browser profile into a managed snapshot.')).toBeTruthy()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('allows a remote managed profile to turn the setting off', async () => {
    $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
    mocks.loadedConfig = { browser: { use_real_profile: true } }
    render(<BrowserRealProfilePanel />)
    const toggle = screen.getByRole('switch', { name: 'Use My Real Browser Profile' })

    expect(toggle).toHaveProperty('disabled', false)

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(mocks.save).toHaveBeenCalledWith({ browser: { use_real_profile: false } }, undefined)
  })

  it('allows turning the setting off while the connection mode is unresolved', async () => {
    $connection.set(null)
    mocks.loadedConfig = { browser: { use_real_profile: true } }
    render(<BrowserRealProfilePanel />)
    const toggle = screen.getByRole('switch', { name: 'Use My Real Browser Profile' })

    expect(toggle).toHaveProperty('disabled', false)

    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(mocks.save).toHaveBeenCalledWith({ browser: { use_real_profile: false } }, undefined)
  })
})
