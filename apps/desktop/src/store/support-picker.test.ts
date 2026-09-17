// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvaManagedStatus } from '@/global'

import {
  $evaManagedStatus,
  activeSupportSession,
  formatSupportRemaining,
  refreshEvaManagedStatus
} from './support-picker'

const refreshActiveProfile = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined))
const refreshProfiles = vi.hoisted(() => vi.fn(async () => []))

vi.mock('@/store/profile', () => ({ refreshActiveProfile, refreshProfiles }))

function status(overrides: Partial<EvaManagedStatus> = {}): EvaManagedStatus {
  return {
    agentId: 'atlas-desk',
    customerId: 'fixture-tenant',
    desktopSessionActive: true,
    desktopSessionExpiresAt: '2030-01-01T00:00:00.000Z',
    email: 'member@example.invalid',
    managed: true,
    productName: 'evaOS Agent',
    profileScopeKey: 'atlas-desk|0|atlas-desk',
    runtimeSessionActive: true,
    runtimeSessionExpiresAt: '2030-01-01T00:00:00.000Z',
    signedOut: false,
    updateChannel: 'stable',
    ...overrides
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  refreshActiveProfile.mockClear()
  refreshProfiles.mockClear()
  $evaManagedStatus.set(null)
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('refreshEvaManagedStatus', () => {
  it('does not rewrite an unchanged no-session status over two poll ticks', async () => {
    const current = status()

    const listener = vi.fn()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { eva: { status: vi.fn(async () => current) } }
    const unlisten = $evaManagedStatus.listen(listener)
    const timer = window.setInterval(() => void refreshEvaManagedStatus(), 1_000)

    await vi.advanceTimersByTimeAsync(2_100)

    window.clearInterval(timer)
    unlisten()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps active-session countdown text moving across poll ticks', async () => {
    const current = status({
      delegatedSupportActive: true,
      supportAgentLabel: 'Field Desk',
      supportCustomerLabel: 'Fixture Customer',
      supportExpiresAt: new Date(Date.now() + 10_000).toISOString()
    })

    const labels: string[] = []

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { eva: { status: vi.fn(async () => current) } }

    const unlisten = $evaManagedStatus.listen(next => {
      const session = activeSupportSession(next)

      if (session) {
        labels.push(formatSupportRemaining(session.expiresAt))
      }
    })

    const timer = window.setInterval(() => void refreshEvaManagedStatus(), 1_000)

    await vi.advanceTimersByTimeAsync(2_100)

    window.clearInterval(timer)
    unlisten()
    expect(new Set(labels).size).toBeGreaterThan(1)
  })
})

describe('profile-scope refresh trigger', () => {
  it('ignores first load and identical keys, then reacts to a direct store write in order', async () => {
    $evaManagedStatus.set(status({ profileScopeKey: 'alpha|0|alpha' }))
    await vi.dynamicImportSettled()
    expect(refreshActiveProfile).not.toHaveBeenCalled()

    $evaManagedStatus.set(status({ profileScopeKey: 'alpha|0|alpha' }))
    await vi.dynamicImportSettled()
    expect(refreshActiveProfile).not.toHaveBeenCalled()

    const order: string[] = []
    refreshActiveProfile.mockImplementationOnce(async () => void order.push('active'))
    refreshProfiles.mockImplementationOnce(async () => {
      order.push('profiles')

      return []
    })
    $evaManagedStatus.set(status({ profileScopeKey: 'alpha,beta|1|alpha' }))
    await vi.dynamicImportSettled()

    expect(order).toEqual(['active', 'profiles'])
  })

  it('waits for an in-progress active-profile refresh before starting the fresh profile fetch', async () => {
    $evaManagedStatus.set(status({ profileScopeKey: 'gamma|0|gamma' }))
    await vi.dynamicImportSettled()
    refreshActiveProfile.mockClear()
    refreshProfiles.mockClear()

    let release!: () => void

    const oldFlight = new Promise<void>(resolve => {
      release = resolve
    })

    refreshActiveProfile.mockImplementationOnce(async () => oldFlight)

    $evaManagedStatus.set(status({ profileScopeKey: 'gamma,delta|1|gamma' }))
    await vi.dynamicImportSettled()
    expect(refreshActiveProfile).toHaveBeenCalledOnce()
    expect(refreshProfiles).not.toHaveBeenCalled()

    release()
    await vi.dynamicImportSettled()
    expect(refreshProfiles).toHaveBeenCalledOnce()
  })
})
