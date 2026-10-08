// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $profiles, adoptActiveGatewayProfile, selectProfile, toggleShowAllProfiles } from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import { WebhooksView } from './index'

// #347 round 4 item 2: under a customer-wide support lease the webhook
// restart banner belongs to the profile whose enable failed. After ⌘⇧0 (All
// profiles) the sibling scope is gone, yet the banner's Restart must still hit
// that sibling — never the anchor. Drives the real WebhooksView, webhook and
// restart builders and system-actions store; only window.hermesDesktop.api is
// stubbed. Synthetic ids — public repo.

const ANCHOR = 'agent-alpha'
const SIBLING = 'agent-bravo'

const profile = (name: string): ProfileInfo => ({
  has_env: false,
  is_default: false,
  model: null,
  name,
  path: `/srv/hermes/${name}`,
  provider: null,
  skill_count: 0
})

type Sent = { method?: string; path: string; profile?: string }

const api = vi.fn(async (request: Sent): Promise<unknown> => {
  if (request.path.startsWith('/api/webhooks/enable')) {
    return { ok: true, restart_started: false, restart_error: 'receiver offline' }
  }

  if (request.path.startsWith('/api/webhooks')) {
    return { base_url: '', enabled: false, subscriptions: [] }
  }

  if (request.path.startsWith('/api/gateway/restart')) {
    return { name: 'gateway-restart' }
  }

  if (request.path.startsWith('/api/actions/')) {
    return { exit_code: 0, running: false }
  }

  return request.path.startsWith('/api/profiles') ? { profiles: [profile(ANCHOR), profile(SIBLING)] } : {}
})

beforeEach(() => {
  api.mockClear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { api }
  adoptActiveGatewayProfile(ANCHOR, true)
  $profiles.set([profile(ANCHOR), profile(SIBLING)])
})

afterEach(() => {
  cleanup()
  adoptActiveGatewayProfile('default', false)
  $profiles.set([])
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('webhook restart banner under customer-wide support (#347)', () => {
  it('keeps restarting the sibling whose enable failed after the scope leaves it', async () => {
    selectProfile(SIBLING)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WebhooksView onClose={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click((await screen.findAllByRole('button', { name: 'Enable webhooks' }))[0])
    await screen.findByText('Gateway restart failed: receiver offline')
    expect(api.mock.calls.find(([request]) => request.path.startsWith('/api/webhooks/enable'))?.[0].profile).toBe(
      SIBLING
    )

    // ⌘⇧0: All profiles — the sibling scope is gone while the banner stays up.
    act(() => toggleShowAllProfiles())

    fireEvent.click(await screen.findByRole('button', { name: 'Restart gateway' }))

    await waitFor(() => expect(api.mock.calls.some(([request]) => request.path === '/api/gateway/restart')).toBe(true))

    const restarts = api.mock.calls.map(([request]) => request).filter(request => request.path === '/api/gateway/restart')

    expect(restarts.map(request => request.profile)).toEqual([SIBLING])
    // The sibling's own success is what clears its banner.
    await waitFor(() => expect(screen.queryByText('Gateway restart failed: receiver offline')).toBeNull())
  })
})
