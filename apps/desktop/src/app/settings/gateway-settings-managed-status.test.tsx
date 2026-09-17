import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EvaManagedStatus } from '@/global'
import { $evaManagedStatus } from '@/store/support-picker'

import { GatewaySettings } from './gateway-settings'

const managedStatus = (overrides: Partial<EvaManagedStatus> = {}): EvaManagedStatus =>
  Object.assign(
    {
      managed: true as const,
      productName: 'evaOS Agent',
      signedOut: false,
      customerId: null,
      email: null,
      desktopSessionExpiresAt: null,
      desktopSessionActive: true,
      runtimeSessionExpiresAt: null,
      runtimeSessionActive: true,
      agentId: 'alpha',
      updateChannel: 'managed-beta',
      delegatedSupportActive: false,
      supportCustomerLabel: null,
      supportAgentLabel: null,
      supportExpiresAt: null,
      supportEndFailed: false
    },
    overrides
  )

const installManagedDesktop = (overrides: Record<string, unknown> = {}) => {
  const status = vi.fn(async () => managedStatus())

  const eva = {
    status,
    refresh: vi.fn(async () => managedStatus()),
    signIn: vi.fn(async () => managedStatus()),
    signOut: vi.fn(async () => undefined),
    switchSupportTarget: vi.fn(async () => managedStatus()),
    endSupportSession: vi.fn(async () => ({ ok: true })),
    ...overrides
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { eva } })

  return eva
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $evaManagedStatus.set(null)
})

describe('managed GatewaySettings status mirror', () => {
  it('mirrors the initial status into the shared store as a copy', async () => {
    const initial = managedStatus()
    installManagedDesktop({ status: vi.fn(async () => initial) })

    render(<GatewaySettings />)

    await waitFor(() => expect($evaManagedStatus.get()).toEqual(initial))
    expect($evaManagedStatus.get()).not.toBe(initial)
  })

  it('mirrors refresh results into the shared store', async () => {
    const initial = managedStatus()
    const refreshed = managedStatus({ agentDisplayName: 'Fixture Agent' })
    const refresh = vi.fn(async () => refreshed)
    installManagedDesktop({ status: vi.fn(async () => initial), refresh })
    render(<GatewaySettings />)
    await screen.findByRole('button', { name: 'Refresh assigned access' })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh assigned access' }))

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    await waitFor(() => expect($evaManagedStatus.get()).toEqual(refreshed))
  })

  it('re-reads status into the shared store after sign-out', async () => {
    const initial = managedStatus()
    const signedOut = managedStatus({ signedOut: true, desktopSessionActive: false })
    const status = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(signedOut)
    const signOut = vi.fn(async () => undefined)
    installManagedDesktop({ status, signOut })
    render(<GatewaySettings />)
    await screen.findByRole('button', { name: 'Sign out' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    await waitFor(() => expect($evaManagedStatus.get()).toEqual(signedOut))
  })
})
