import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvaManagedStatus } from '@/global'
import { $evaManagedStatus, $supportPickerOpen, setSupportPickerOpen } from '@/store/support-picker'

// Collect the component graph before the behavioral test deadline starts.
import { GatewaySettings } from './gateway-settings'

const { registry, activeId, selectConnection } = vi.hoisted(() => ({
  registry: { value: null as any },
  activeId: { value: 'saved-b' },
  selectConnection: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@nanostores/react', () => ({ useStore: (store: any) => store.value }))
vi.mock('@/store/connections', () => ({
  $connectionsRegistry: registry,
  $activeConnectionId: activeId,
  refreshConnectionsRegistry: vi.fn().mockResolvedValue(null),
  selectConnection,
  setConnectionsRegistry: vi.fn()
}))
vi.mock('./connections-registry', async importOriginal => ({
  ...(await importOriginal<any>()),
  ConnectionsRegistrySection: () => null
}))
const getConnectionConfig = vi.fn()
const saveConnectionConfig = vi.fn()

// This test owns the machine-level GatewaySettings contract. The managed SSH
// update section mounted below the registry has its own focused coverage
// (store/managed-updates.test.ts); keep its store subscriptions out of this
// single-purpose test.
vi.mock('./managed-updates-section', () => ({ ManagedUpdatesSection: () => null }))

const localConnection = {
  cloudOrg: '',
  envOverride: false,
  mode: 'local',
  remoteAuthMode: 'token',
  remoteOauthConnected: false,
  remoteTokenPreview: null,
  remoteTokenSet: false,
  remoteUrl: ''
}

beforeEach(() => {
  getConnectionConfig.mockResolvedValue(localConnection)
  saveConnectionConfig.mockResolvedValue(localConnection)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getConnectionConfig, saveConnectionConfig }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  $evaManagedStatus.set(null)
  setSupportPickerOpen(false)
})

describe('GatewaySettings', () => {
  it('runs the active support-session card controls and live countdown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2030-01-01T00:00:00.000Z')
    let current = {
      managed: true,
      productName: 'evaOS Agent',
      signedOut: false,
      desktopSessionActive: true,
      updateChannel: 'managed-beta',
      delegatedSupportActive: true,
      supportCustomerLabel: 'Customer',
      supportAgentLabel: 'Agent',
      supportExpiresAt: '2030-01-01T00:00:05.000Z',
      supportEndFailed: true
    } as EvaManagedStatus
    const status = vi.fn(async () => current)
    const switchSupportTarget = vi.fn(async () => current)
    const endSupportSession = vi.fn(async () => {
      current = { ...current, delegatedSupportActive: false }
      return { ok: true }
    })
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { eva: { status, switchSupportTarget, endSupportSession } }
    })
    $evaManagedStatus.set(current)
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<GatewaySettings />)
    })
    const card = screen.getByRole('region', { name: 'Support session' })
    expect(card.textContent).toContain('Ends in 00:00:05')
    expect(screen.getByRole('status').textContent).toContain('Unable to end support session')
    act(() => vi.advanceTimersByTime(1_000))
    expect(card.textContent).toContain('Ends in 00:00:04')
    $evaManagedStatus.set({ ...current, supportCustomerLabel: 'Other customer' })
    view.rerender(<GatewaySettings />)
    expect(card.textContent).toContain('Other customer')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Switch support target…' })))
    expect(switchSupportTarget).toHaveBeenCalledOnce()
    expect($supportPickerOpen.get()).toBe(true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'End support session' })))
    expect(endSupportSession).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region', { name: 'Support session' })).toBeNull()
  })

  it('keeps saved Cloud instances usable without discovery and marks the live source, not the default', async () => {
    getConnectionConfig.mockResolvedValue({ ...localConnection, mode: 'cloud', remoteUrl: 'https://a.example' })
    registry.value = {
      connections: [
        { id: 'saved-a', kind: 'cloud', label: 'Research', url: 'https://a.example', authMode: 'oauth' },
        { id: 'saved-b', kind: 'cloud', label: 'Writing', url: 'https://b.example', authMode: 'oauth' }
      ]
    }
    const agentSignIn = vi.fn()
    const applyConnectionConfig = vi.fn()
    Object.assign(window.hermesDesktop, {
      applyConnectionConfig,
      cloud: {
        status: vi.fn().mockResolvedValue({ signedIn: false }),
        agentSignIn
      }
    })
    render(<GatewaySettings embedded />)
    const research = await screen.findByText('Research')
    const row = research.closest('[data-slot]') ?? research.parentElement!.parentElement!
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Use gateway' }))
    await waitFor(() => expect(selectConnection).toHaveBeenCalledWith('saved-a'))
    expect(screen.getByText('Active in this window')).toBeTruthy()
    expect(agentSignIn).not.toHaveBeenCalled()
    expect(applyConnectionConfig).not.toHaveBeenCalled()
    registry.value = null
  })
  it('authenticates and saves only the chosen discovered instance with its friendly name', async () => {
    registry.value = null
    getConnectionConfig.mockResolvedValue({ ...localConnection, mode: 'cloud' })
    const agentSignIn = vi.fn().mockResolvedValue({ connected: true })
    const applyConnectionConfig = vi.fn().mockResolvedValue({ ...localConnection, mode: 'cloud' })
    Object.assign(window.hermesDesktop, {
      applyConnectionConfig,
      cloud: {
        status: vi.fn().mockResolvedValue({ signedIn: true }),
        agentSignIn,
        discover: vi.fn().mockResolvedValue({
          agents: [
            { id: 'new-a', name: 'Research Bot', dashboardUrl: 'https://new-a.example' },
            { id: 'new-b', name: 'Writing Bot', dashboardUrl: 'https://new-b.example' }
          ],
          org: { id: 'org-a' }
        })
      }
    })
    render(<GatewaySettings embedded />)
    const buttons = await screen.findAllByRole('button', { name: 'Connect', exact: true })
    expect(agentSignIn).not.toHaveBeenCalled()
    expect(applyConnectionConfig).not.toHaveBeenCalled()
    fireEvent.click(buttons[0])
    await waitFor(() =>
      expect(applyConnectionConfig).toHaveBeenCalledWith({
        mode: 'cloud',
        remoteAuthMode: 'oauth',
        remoteUrl: 'https://new-a.example',
        cloudOrg: 'org-a',
        cloudName: 'Research Bot'
      })
    )
    expect(agentSignIn).toHaveBeenCalledExactlyOnceWith('https://new-a.example')
    expect(applyConnectionConfig).toHaveBeenCalledTimes(1)
  })
  it('loads the machine-level connection config (no profile scoping)', async () => {
    render(<GatewaySettings />)
    expect(await screen.findByText('Local gateway')).toBeTruthy()
    expect(
      screen.getByText('Start a private Hermes backend on localhost. This is the default and works offline.')
    ).toBeTruthy()

    // The page manages the machine's gateway connections; it must load the
    // global config, never a per-profile override.
    await waitFor(() => expect(getConnectionConfig).toHaveBeenCalledWith(null))
    expect(getConnectionConfig).not.toHaveBeenCalledWith(expect.any(String))

    // The legacy per-profile scope switcher must not render.
    expect(screen.queryByText('Applies to')).toBeNull()
    expect(screen.queryByText('All profiles')).toBeNull()
    expect(screen.queryByText('Use default gateway')).toBeNull()
  })
})
