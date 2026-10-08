// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import { setSidebarAgentsGrouped } from '@/store/layout'
import { $profiles, adoptActiveGatewayProfile, selectProfile } from '@/store/profile'
import { $projectTree, refreshProjectTree } from '@/store/projects'
import { $sessions } from '@/store/session'
import { makeSessionInfo } from '@/test/session-info'
import type { ProfileInfo } from '@/types/hermes'

import { ChatSidebar } from './index'

// #347 round 4 item 1: under a customer-wide support lease the cached project
// tree belongs to the profile it was read for. After the anchor's tree loaded,
// picking a sibling must never paint the anchor's projects or preview rows —
// not while the sibling's read is pending, and not after it fails. Drives the
// real projects store and ChatSidebar; only the two sockets are stubbed.
// Synthetic ids — public repo.

const ANCHOR = 'agent-alpha'
const SIBLING = 'agent-bravo'

const sockets = vi.hoisted(() => {
  const anchorTree = {
    active_id: null,
    projects: [
      {
        id: '/repos/alpha-repo',
        label: 'alpha-repo',
        path: '/repos/alpha-repo',
        previewSessions: [{ id: 'alpha-preview', profile: 'agent-alpha', started_at: 1, title: 'Alpha preview row' }],
        repos: [],
        sessionCount: 1,
        sessionIds: ['alpha-preview']
      }
    ],
    scoped_session_ids: ['alpha-preview']
  }

  const state = { rejectSibling: (_error: Error) => {} }

  return {
    anchor: { connectionState: 'open', request: vi.fn(async () => anchorTree) },
    sibling: vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          state.rejectSibling = reject
        })
    ),
    state
  }
})

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activeGateway: () => sockets.anchor,
  ensureActiveGatewayOpen: async () => sockets.anchor,
  requestGatewayForProfile: () => sockets.sibling()
}))

const profile = (name: string): ProfileInfo => ({
  has_env: false,
  is_default: false,
  model: null,
  name,
  path: `/srv/hermes/${name}`,
  provider: null,
  skill_count: 0
})

const noop = () => {}

const noopAsync = async () => {}

beforeEach(() => {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    api: vi.fn(async () => ({ profiles: [profile(ANCHOR), profile(SIBLING)] }))
  }
  adoptActiveGatewayProfile(ANCHOR, true)
  $profiles.set([profile(ANCHOR), profile(SIBLING)])
  setSidebarAgentsGrouped(true)
  // One loaded row per agent, so neither scope is an empty list.
  $sessions.set([
    makeSessionInfo({ id: 'alpha-preview', last_active: 2, profile: ANCHOR, started_at: 1, title: 'Alpha preview row' }),
    makeSessionInfo({ id: 'bravo-row', last_active: 2, profile: SIBLING, started_at: 1, title: 'Bravo row' })
  ])
})

afterEach(() => {
  cleanup()
  setSidebarAgentsGrouped(false)
  $sessions.set([])
  $projectTree.set([])
  adoptActiveGatewayProfile('default', false)
  $profiles.set([])
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('project tree ownership under customer-wide support (#347)', () => {
  it('never renders the anchor’s cached projects or previews under a picked sibling', async () => {
    await refreshProjectTree()
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

    // Precondition: the anchor's tree is what the anchor scope shows.
    expect(screen.getByText('alpha-repo')).toBeTruthy()

    let pending: Promise<void> = Promise.resolve()

    act(() => {
      selectProfile(SIBLING)
      pending = refreshProjectTree()
    })

    // The sibling's read is in flight (and stays pending until rejected below).
    await act(async () => {
      await vi.waitFor(() => expect(sockets.sibling).toHaveBeenCalled())
    })
    expect(screen.queryByText('alpha-repo')).toBeNull()
    expect(screen.queryByText('Alpha preview row')).toBeNull()

    await act(async () => {
      sockets.state.rejectSibling(new Error('sibling read failed'))
      await pending
    })

    expect(screen.queryByText('alpha-repo')).toBeNull()
    expect(screen.queryByText('Alpha preview row')).toBeNull()
    // With no tree of its own, the sibling's sessions show ungrouped.
    expect(screen.getByText('Bravo row')).toBeTruthy()
  })
})
