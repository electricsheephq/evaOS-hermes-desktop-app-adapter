import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EvaManagedStatus } from '@/global'
import { I18nProvider } from '@/i18n'
import { $evaManagedStatus, $supportPickerOpen, setSupportPickerOpen } from '@/store/support-picker'

import { DelegatedSupportBanner } from './delegated-support-banner'

function supportStatus(): EvaManagedStatus {
  return {
    managed: true,
    productName: 'evaOS Agent',
    signedOut: false,
    customerId: null,
    email: 'employee@example.invalid',
    desktopSessionExpiresAt: '2099-01-01T00:00:00.000Z',
    desktopSessionActive: true,
    runtimeSessionExpiresAt: '2099-01-01T00:00:00.000Z',
    runtimeSessionActive: true,
    agentId: null,
    agentDisplayName: 'Support agent',
    profileScopeKey: 'fixture-agent|0|fixture-agent',
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
  $evaManagedStatus.set(null)
})

describe('DelegatedSupportBanner', () => {
  it('renders nothing at root for an active support session', async () => {
    const status = vi.fn().mockResolvedValue(supportStatus())
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { status } }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DelegatedSupportBanner />
      </I18nProvider>
    )

    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('keeps End reachable for a lease the app still holds a handle for but no longer an enrollment', async () => {
    const status = vi.fn().mockResolvedValue({
      ...supportStatus(),
      delegatedSupportActive: false,
      sessionKind: 'ordinary',
      supportCustomerLabel: null,
      supportAgentLabel: null,
      supportExpiresAt: null,
      supportCleanupPending: true,
      supportTargetLabel: 'Acme / Fixture Agent',
      supportEndFailed: true
    })

    const endSupportSession = vi.fn().mockResolvedValue({ ok: false })
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { status, endSupportSession } }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DelegatedSupportBanner />
      </I18nProvider>
    )

    const banner = await screen.findByRole('region', { name: 'A previous support session still needs to be ended.' })
    expect(banner.textContent).toMatch(/Acme \/ Fixture Agent/)
    expect((await screen.findByText('Unable to end support session. Try again.')).getAttribute('role')).toBe('status')
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      'Switch support target…',
      'End support session'
    ])

    fireEvent.click(screen.getByRole('button', { name: 'End support session' }))
    await waitFor(() => expect(endSupportSession).toHaveBeenCalledTimes(1))
  })

  it('opens the in-app picker once the switch has a desktop session, without signing out', async () => {
    setSupportPickerOpen(false)
    const status = vi
      .fn()
      .mockResolvedValue({ ...supportStatus(), delegatedSupportActive: false, missingAgentBinding: true })
    const switchSupportTarget = vi.fn().mockResolvedValue({ ...supportStatus(), supportPickerAvailable: true })
    const signOut = vi.fn()
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { status, switchSupportTarget, signOut } }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DelegatedSupportBanner />
      </I18nProvider>
    )

    await screen.findByRole('region', { name: 'No personal agent for this account' })
    fireEvent.click(screen.getByRole('button', { name: 'Switch support target…' }))

    await waitFor(() => expect(switchSupportTarget).toHaveBeenCalledTimes(1))
    await waitFor(() => expect($supportPickerOpen.get()).toBe(true))
    expect(signOut).not.toHaveBeenCalled()
  })
})
