import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import type { ProfileInfo } from '@/types/hermes'

const getConnectionConfig = vi.fn()
const saveConnectionConfig = vi.fn()
const profiles = atom<ProfileInfo[]>([])

vi.mock('@/store/profile', () => ({
  $profiles: profiles,
  refreshActiveProfile: vi.fn()
}))

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
  profiles.set([
    {
      has_env: false,
      is_default: true,
      model: null,
      name: 'default',
      path: '/tmp/hermes',
      provider: null,
      skill_count: 0
    },
    {
      has_env: false,
      is_default: false,
      model: null,
      name: 'work',
      path: '/tmp/hermes/profiles/work',
      provider: null,
      skill_count: 0
    }
  ])
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
})

describe('GatewaySettings', () => {
  it('shows a safe broker code without rendering rejected backend detail', async () => {
    const { safeManagedErrorMessage } = await import('./gateway-settings')

    expect(
      safeManagedErrorMessage(
        new Error('Electric Sheep request failed (403). [code: feature_not_enabled]'),
        'Connection failed'
      )
    ).toBe('Electric Sheep request failed [code: feature_not_enabled]')
    expect(
      safeManagedErrorMessage(
        new Error('token=secret customer=private https://internal.example.invalid'),
        'Connection failed'
      )
    ).toBe('Connection failed')
    expect(safeManagedErrorMessage(new Error('jackie-david'), 'Connection failed')).toBe('Connection failed')
    expect(
      safeManagedErrorMessage(
        new Error('Electric Sheep request failed (403). [code: customer_opaquevalue]'),
        'Connection failed'
      )
    ).toBe('Connection failed')
    expect(safeManagedErrorMessage(new Error('line one\nline two'), 'Connection failed')).toBe('Connection failed')
    expect(
      safeManagedErrorMessage(
        new Error('evaOS Agent cannot receive sign-in links. [code: callback-handler-mismatch]'),
        'Connection failed',
        code => (code.startsWith('callback-') ? 'Repair the application handler' : `Failure: ${code}`)
      )
    ).toBe('Repair the application handler')
  })

  it('labels local mode as default inheritance for a named profile', async () => {
    const { GatewaySettings } = await import('./gateway-settings')

    render(<GatewaySettings />)
    expect(await screen.findByText('Local gateway')).toBeTruthy()
    expect(screen.getByText(en.settings.gateway.localDesc)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'work' }))

    await waitFor(() => expect(getConnectionConfig).toHaveBeenLastCalledWith('work'))
    expect(await screen.findByText('Use default gateway')).toBeTruthy()
    expect(screen.getByText("Remove this profile's override and use the default connection.")).toBeTruthy()
    expect(screen.queryByText(en.settings.gateway.localDesc)).toBeNull()
  })

  it('uses managed enrollment labels for presentation while hiding canonical ids', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: {
          status: vi.fn().mockResolvedValue({
            agentDisplayName: 'Asuka',
            agentId: 'canonical-agent',
            customerId: 'canonical-customer',
            desktopSessionActive: true,
            desktopSessionExpiresAt: null,
            email: null,
            managed: true,
            productName: 'evaOS Agent',
            runtimeSessionActive: true,
            runtimeSessionExpiresAt: null,
            signedOut: false,
            updateChannel: 'managed-beta'
          })
        }
      }
    })

    const { GatewaySettings } = await import('./gateway-settings')

    render(<GatewaySettings />)

    expect(await screen.findByText('Electric Sheep')).toBeTruthy()
    expect(await screen.findByText('Asuka')).toBeTruthy()
    expect(screen.queryByText('canonical-customer')).toBeNull()
    expect(screen.queryByText('canonical-agent')).toBeNull()
  })

  it('shows actionable copy when another app owns managed sign-in links', async () => {
    const signedOutStatus = {
      agentDisplayName: null,
      agentId: null,
      customerId: null,
      desktopSessionActive: false,
      desktopSessionExpiresAt: null,
      email: null,
      managed: true,
      productName: 'evaOS Agent',
      runtimeSessionActive: false,
      runtimeSessionExpiresAt: null,
      signedOut: true,
      updateChannel: 'managed-beta'
    }

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: {
          status: vi.fn().mockResolvedValue(signedOutStatus),
          signIn: vi
            .fn()
            .mockRejectedValue(new Error('evaOS Agent cannot receive sign-in links. [code: callback-handler-mismatch]'))
        }
      }
    })

    const { GatewaySettings } = await import('./gateway-settings')

    render(<GatewaySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to evaOS Agent' }))

    expect(await screen.findByText(en.settings.gateway.managed.callbackHandlerUnavailable)).toBeTruthy()
  })

  it('shows and clears an SSH remote-profile mapping for a named Desktop profile', async () => {
    getConnectionConfig.mockImplementation(async profile =>
      profile === 'work'
        ? {
            ...localConnection,
            mode: 'ssh',
            profile: 'work',
            sshHost: 'remote-box',
            sshUser: 'alice',
            sshPort: 22,
            sshKeyPath: '',
            sshRemoteHermesPath: '/opt/hermes/bin/hermes',
            sshRemoteProfile: 'default'
          }
        : localConnection
    )
    saveConnectionConfig.mockReturnValue(new Promise(() => {}))
    const { GatewaySettings } = await import('./gateway-settings')

    render(<GatewaySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'work' }))

    await waitFor(() => expect(getConnectionConfig).toHaveBeenLastCalledWith('work'))
    expect(await screen.findByText('Remote profile (optional)')).toBeTruthy()

    const input = screen.getByPlaceholderText('work')

    expect((input as HTMLInputElement).value).toBe('default')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save for next restart' }))

    await waitFor(() =>
      expect(saveConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: 'work',
          sshRemoteProfile: ''
        })
      )
    )
  })
})
