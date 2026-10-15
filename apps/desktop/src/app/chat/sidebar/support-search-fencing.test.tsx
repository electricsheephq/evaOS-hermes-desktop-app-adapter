// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { renameSession } from '@/hermes'
import { $profiles, adoptActiveGatewayProfile, selectProfile } from '@/store/profile'
import type { ProfileInfo, SessionSearchResponse } from '@/types/hermes'

import { ChatSidebar, mergeSearchResults } from './index'

// #347 item 1: under a customer-wide support lease the sidebar's session
// search is keyed by (scope, query). Picking a sibling while a query is open
// re-runs it for the sibling, and the anchor's late answer never paints under
// the sibling. Drives the real ChatSidebar, profile store and search builder;
// only window.hermesDesktop.api is stubbed. Synthetic ids — public repo.

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

const hit = (owner: string, id: string): SessionSearchResponse => ({
  results: [
    {
      model: null,
      profile: owner,
      role: 'user',
      session_id: id,
      session_started: 1,
      snippet: `${owner} snippet`,
      source: null
    }
  ]
})

type Pending = { profile?: string; resolve: (value: SessionSearchResponse) => void }

const searches: Pending[] = []

const api = vi.fn((request: { body?: unknown; method?: string; path: string; profile?: string }) => {
  if (request.path.startsWith('/api/sessions/search')) {
    return new Promise<SessionSearchResponse>(resolve => searches.push({ profile: request.profile, resolve }))
  }

  // The profile roster is the grant's two agents; nothing else matters here.
  return Promise.resolve(
    request.path.startsWith('/api/profiles?') || request.path === '/api/profiles'
      ? { profiles: [profile(ANCHOR), profile(SIBLING)] }
      : {}
  )
})

const noop = () => {}

const noopAsync = async () => {}

beforeEach(() => {
  searches.length = 0
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

describe('sidebar search under customer-wide support (#347)', () => {
  it('re-runs an open query for a picked sibling and drops the anchor’s late hits', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SidebarProvider>
          <ChatSidebar
            currentView="chat"
            onArchiveSession={noop}
            onBranchSession={noop}
            onDeleteSession={noop}
            onLoadMoreSessions={noop}
            onManageCronJob={noop}
            onNavigate={noop}
            onNewSessionInWorkspace={noop}
            onNewSessionSplit={noop}
            onResumeSession={noop}
            onRetrySessions={noopAsync}
            onTriggerCronJob={noopAsync}
          />
        </SidebarProvider>
      </MemoryRouter>
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions' }), { target: { value: 'invoice' } })
    await waitFor(() => expect(searches).toHaveLength(1))

    act(() => selectProfile(SIBLING))
    await waitFor(() => expect(searches).toHaveLength(2))
    expect(searches[1].profile).toBe(SIBLING)

    await act(async () => {
      searches[0].resolve(hit(ANCHOR, 'alpha-hit'))
      searches[1].resolve(hit(SIBLING, 'bravo-hit'))
    })

    await waitFor(() => expect(screen.queryByText(`${SIBLING} snippet`)).toBeTruthy())
    expect(screen.queryByText(`${ANCHOR} snippet`)).toBeNull()
  })

  it('drops a hit stamped with another agent than the one in view', () => {
    const merged = mergeSearchResults([], 'invoice', hit(ANCHOR, 'alpha-hit').results, new Map(), false, SIBLING)

    expect(merged).toEqual([])
  })

  it('an unloaded sibling hit keeps its owner, so its rename lands on the sibling, not the anchor (item 2)', async () => {
    const [row] = mergeSearchResults([], 'invoice', hit(SIBLING, 'bravo-hit').results, new Map(), false, SIBLING)

    expect(row.profile).toBe(SIBLING)

    // The row menu hands the row's owner to the write (session-row → SessionActionsMenu).
    await renameSession(row.id, 'Renamed', row.profile)
    const write = api.mock.calls
      .map(([request]) => request)
      .findLast(request => request.path === '/api/sessions/bravo-hit')

    expect(write).toMatchObject({ body: { profile: SIBLING }, method: 'PATCH', profile: SIBLING })
  })
})
