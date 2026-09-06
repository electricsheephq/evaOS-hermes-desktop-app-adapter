import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EvaManagedStatus } from '@/global'
import { I18nProvider } from '@/i18n'

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
})

describe('app-root delegated support controls', () => {
  it.each(['Connecting', 'Gateway connection failed'])(
    'retains the customer identity and working End control during %s',
    async state => {
      gateway.state = state
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
    }
  )
})
