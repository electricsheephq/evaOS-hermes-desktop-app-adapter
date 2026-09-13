import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EvaManagedStatus } from '@/global'
import { I18nProvider } from '@/i18n'
import { setSupportPickerOpen } from '@/store/support-picker'

import App from './index'

const gateway = vi.hoisted(() => ({ state: 'Connecting' }))

vi.mock('./contrib', () => ({
  ContribController: () => <div role="status">{gateway.state}</div>
}))

function supportStatus(): EvaManagedStatus {
  return {
    managed: true,
    productName: 'evaOS Agent',
    signedOut: false,
    customerId: null,
    email: 'employee@example.invalid',
    desktopSessionExpiresAt: '2099-01-01T00:00:00.000Z',
    desktopSessionActive: true,
    runtimeSessionExpiresAt: null,
    runtimeSessionActive: false,
    agentId: null,
    agentDisplayName: 'Support agent',
    updateChannel: 'managed-beta',
    delegatedSupportActive: true,
    sessionKind: 'delegated_support',
    supportCustomerLabel: 'Customer',
    supportAgentLabel: 'Support agent',
    supportExpiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    supportDeadline: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    assignmentVersion: 'assignment-v1'
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // The picker's open state is a renderer store; a test that opened it must
  // not leave the modal over the next test's banner.
  setSupportPickerOpen(false)
})

describe('app-root delegated support controls', () => {
  it('retains the customer identity and working End control while connecting', async () => {
    const state = gateway.state
    let status = supportStatus()

    const endSupportSession = vi.fn(async () => {
      status = { ...status, delegatedSupportActive: false }

      return { ok: true }
    })

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { status: async () => status, endSupportSession } }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <App />
      </I18nProvider>
    )

    expect(screen.getByText(state)).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Acting for Customer' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'End support session' }))
    await waitFor(() => expect(endSupportSession).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Acting for Customer' })).toBeNull())
    expect(screen.getByText(state)).toBeTruthy()
  })

  // adapter#91 / sc#540: an internal admin has no agent of their own, so the
  // ordinary enrollment is rejected 403 by design. The banner is the only
  // surface that survives that boot, so it carries the way out.
  it('offers Switch support target from the no-personal-agent state and opens the in-app picker', async () => {
    const status: EvaManagedStatus = { ...supportStatus(), delegatedSupportActive: false, missingAgentBinding: true }
    const switchSupportTarget = vi.fn(async () => ({ ...status, supportPickerAvailable: true }))
    const listSupportTargets = vi.fn(async () => ({ ok: true as const, is_admin: false, clients: [] }))

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: {
          status: async () => status,
          endSupportSession: async () => ({ ok: true }),
          switchSupportTarget,
          listSupportTargets
        }
      }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <App />
      </I18nProvider>
    )

    expect(await screen.findByRole('region', { name: 'No personal agent for this account' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'End support session' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Switch support target…' }))
    await waitFor(() => expect(switchSupportTarget).toHaveBeenCalledTimes(1))
    // sc#540: the picker is an app surface over whatever the root shows — the
    // 403 boot failure included — and it lists over the session the switch
    // just guaranteed.
    expect(await screen.findByRole('dialog', { name: 'Switch support target' })).toBeTruthy()
    await waitFor(() => expect(listSupportTargets).toHaveBeenCalledTimes(1))
    expect(screen.getByText(gateway.state)).toBeTruthy()
  })

  // A cancelled browser or an expired device code leaves the main process
  // signed out but still without a personal agent, so the banner must survive
  // the failure and keep offering the way out.
  it('keeps the no-personal-agent banner and names the failure when the switch never starts', async () => {
    const status: EvaManagedStatus = { ...supportStatus(), delegatedSupportActive: false, missingAgentBinding: true }

    const switchSupportTarget = vi.fn(async () => {
      throw new Error('no browser')
    })

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { status: async () => status, endSupportSession: async () => ({ ok: true }), switchSupportTarget } }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <App />
      </I18nProvider>
    )

    await screen.findByRole('region', { name: 'No personal agent for this account' })
    fireEvent.click(screen.getByRole('button', { name: 'Switch support target…' }))
    await waitFor(() => expect(switchSupportTarget).toHaveBeenCalledTimes(1))

    expect(await screen.findByText('Unable to start the support target switch. Try again.')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'No personal agent for this account' })).toBeTruthy()

    const retry = screen.getByRole('button', { name: 'Switch support target…' })
    await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false))
    fireEvent.click(retry)
    await waitFor(() => expect(switchSupportTarget).toHaveBeenCalledTimes(2))
  })

  it('offers Switch support target beside End during an active session', async () => {
    const status = supportStatus()
    const switchSupportTarget = vi.fn(async () => status)

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { status: async () => status, endSupportSession: async () => ({ ok: true }), switchSupportTarget } }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <App />
      </I18nProvider>
    )

    await screen.findByRole('region', { name: 'Acting for Customer' })
    fireEvent.click(screen.getByRole('button', { name: 'Switch support target…' }))
    await waitFor(() => expect(switchSupportTarget).toHaveBeenCalledTimes(1))
  })
})
