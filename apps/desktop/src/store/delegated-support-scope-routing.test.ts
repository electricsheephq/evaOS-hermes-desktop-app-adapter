import { createRequire } from 'node:module'

import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProfileInfo } from '@/types/hermes'

// #347: under a customer-wide ("All authorized agents") support lease the
// gateway socket stays pinned to the lease anchor (#285) while a rail pick
// moves the sidebar to a sibling. Every surface that renders that scope must
// then read and write the sibling — never the anchor under the sibling's name.
// This drives the REAL profile store, projects store and REST request builders;
// only the transport seams (window.hermesDesktop.api, the gateway socket) are
// stubbed, and each REST request is fed through Electron's real managed policy.

vi.mock('@/i18n', () => ({ translateNow: (key: string) => key }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph: vi.fn() }))
vi.mock('@/lib/desktop-fs', () => ({
  desktopDefaultCwd: vi.fn(),
  isDesktopFsRemoteMode: vi.fn(),
  selectDesktopPaths: vi.fn(),
  writeDesktopFileText: vi.fn()
}))
vi.mock('@/lib/desktop-git', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  desktopGit: vi.fn()
}))

const socketRequest = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
  active_id: null,
  projects: [],
  scoped_session_ids: []
}))

const socket = { connectionState: 'open', request: socketRequest }
const ensureGatewayForProfile = vi.fn(async (_profile: string) => undefined)

vi.mock('@/store/gateway', () => ({
  $gateway: atom<unknown>(null),
  activeGateway: () => socket,
  activeGatewayConnectionId: () => null,
  activeGatewayProfileKey: () => 'default',
  ensureActiveGatewayOpen: vi.fn(async () => socket),
  ensureGatewayForAgent: vi.fn(async () => true),
  ensureGatewayForProfile,
  openGatewayForAgent: vi.fn(async () => undefined),
  openGatewayForProfile: vi.fn(async () => undefined),
  openSecondaryCount: () => 0,
  primaryGatewayConnectionId: () => null
}))

const {
  $activeGatewayProfile,
  $newChatProfile,
  $profileScope,
  $profiles,
  $showAllProfiles,
  adoptActiveGatewayProfile,
  selectProfile,
  sidebarProfileForScope
} = await import('@/store/profile')

const { createCronJob, deleteWebhook, getCronJobs, getWebhooks, searchSessions } = await import('@/hermes')
const { refreshProjectTree } = await import('@/store/projects')
const { runGatewayRestart } = await import('@/store/system-actions')

const { assertEvaManagedApiRequestAllowed } = createRequire(import.meta.url)('../../electron/eva-managed.cjs') as {
  assertEvaManagedApiRequestAllowed: (request: { method?: string; path: string; profile?: string }) => { path: string }
}

// Synthetic profile ids only — this repo is public.
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

interface SentRequest {
  method?: string
  path: string
  profile?: string
}

// Any JSON body satisfies the helpers here; an array also reads as a cron list.
// A gateway restart starts an action that has already finished cleanly.
const api = vi.fn(
  async (request: SentRequest) =>
    (request.path.startsWith('/api/gateway/restart')
      ? { name: 'gateway-restart' }
      : request.path.startsWith('/api/actions/')
        ? { exit_code: 0, running: false }
        : []) as never
)

const sent = (pathPrefix: string): SentRequest => {
  const call = api.mock.calls.findLast(([request]) => request.path.startsWith(pathPrefix))

  if (!call) {
    throw new Error(`no request to ${pathPrefix}`)
  }

  return call[0]
}

const queryProfile = (request: SentRequest): null | string =>
  new URL(request.path, 'http://renderer.invalid').searchParams.get('profile')

// The profile Electron's managed policy routes the request to: it rejects a
// query/routing disagreement (403 managed-escape) and fills an absent query
// from the routing profile.
const policyProfile = (request: SentRequest): null | string =>
  new URL(assertEvaManagedApiRequestAllowed(request).path, 'http://backend.invalid').searchParams.get('profile')

const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  api.mockClear()
  socketRequest.mockClear()
  ensureGatewayForProfile.mockClear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { api }
  $showAllProfiles.set(false)
  $newChatProfile.set(null)
  $profiles.set([profile(ANCHOR), profile(SIBLING)])
})

afterEach(() => {
  adoptActiveGatewayProfile('default', false)
  $newChatProfile.set(null)
  $profiles.set([])
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('customer-wide support: scope consumers follow the rail pick (#347)', () => {
  beforeEach(async () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    selectProfile(SIBLING)
    await settle()
  })

  it('keeps the socket on the anchor while the sidebar scope is the sibling', () => {
    expect($activeGatewayProfile.get()).toBe(ANCHOR)
    expect(ensureGatewayForProfile).not.toHaveBeenCalled()
    expect($profileScope.get()).toBe(SIBLING)
  })

  it('session search targets the sibling', async () => {
    await searchSessions('invoice')
    const request = sent('/api/sessions/search')

    expect(request.profile).toBe(SIBLING)
    expect(queryProfile(request)).toBeNull()
    expect(policyProfile(request)).toBe(SIBLING)
  })

  it('the cron list carries the sibling in the query and the routing profile, so policy admits it', async () => {
    await getCronJobs(sidebarProfileForScope($profileScope.get()))
    const request = sent('/api/cron/jobs')

    expect(queryProfile(request)).toBe(SIBLING)
    // An anchor routing profile under the sibling's query is a 403 managed-escape.
    expect(policyProfile(request)).toBe(SIBLING)
    expect(request.profile).toBe(SIBLING)
  })

  it('a manual cron create (the page passes no profile in a concrete scope) writes the sibling', async () => {
    await createCronJob({ name: 'nightly', prompt: 'run', schedule: '0 3 * * *' } as never)
    const request = sent('/api/cron/jobs')

    expect(request.method).toBe('POST')
    expect(request.profile).toBe(SIBLING)
    expect(policyProfile(request)).toBe(SIBLING)
  })

  it('webhooks list and delete target the sibling', async () => {
    await getWebhooks()
    const list = sent('/api/webhooks')

    expect(list.profile).toBe(SIBLING)
    expect(policyProfile(list)).toBe(SIBLING)

    await deleteWebhook('deploy-hook')
    const remove = sent('/api/webhooks/deploy-hook')

    expect(remove.method).toBe('DELETE')
    expect(remove.profile).toBe(SIBLING)
    expect(policyProfile(remove)).toBe(SIBLING)
  })

  it('picking the anchor again routes everything back to it, in the base shapes', async () => {
    selectProfile(ANCHOR)
    await settle()

    await searchSessions('invoice')
    await getWebhooks()

    expect(sent('/api/sessions/search')).not.toHaveProperty('profile')
    expect(sent('/api/webhooks').profile).toBe(ANCHOR)
  })

  it('restarting the gateway for the sibling restarts and polls the sibling, never the anchor', async () => {
    vi.useFakeTimers()

    try {
      const restart = runGatewayRestart(SIBLING)
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(restart).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }

    const touched = api.mock.calls.map(([request]) => request)

    expect(sent('/api/gateway/restart').profile).toBe(SIBLING)
    expect(sent('/api/actions/').profile).toBe(SIBLING)
    expect(sent('/api/status').profile).toBe(SIBLING)
    expect(touched.filter(request => request.profile === ANCHOR)).toEqual([])
  })
})

describe('single-agent support lease (#347 item 6)', () => {
  it('keeps session search in its base, unscoped shape', async () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([profile(ANCHOR)])

    await searchSessions('invoice')

    expect(sent('/api/sessions/search')).not.toHaveProperty('profile')
  })
})

describe('outside delegated support (unchanged request shapes)', () => {
  it('routes by the live gateway profile and leaves session search unscoped', async () => {
    adoptActiveGatewayProfile(ANCHOR, false)
    // An ordinary new-chat intent is not a scope change.
    $newChatProfile.set(SIBLING)

    await searchSessions('invoice')
    await getCronJobs(sidebarProfileForScope($profileScope.get()))
    await createCronJob({ name: 'nightly', prompt: 'run', schedule: '0 3 * * *' } as never)
    await getWebhooks()
    await refreshProjectTree()

    expect(sent('/api/sessions/search')).not.toHaveProperty('profile')
    expect(api.mock.calls.filter(([request]) => request.path.startsWith('/api/cron/jobs'))).toHaveLength(2)

    for (const [request] of api.mock.calls.filter(([request]) => request.path.startsWith('/api/cron/jobs'))) {
      expect(request.profile).toBe(ANCHOR)
    }

    expect(queryProfile(sent('/api/cron/jobs'))).toBeNull()
    expect(sent('/api/webhooks').profile).toBe(ANCHOR)
    expect(socketRequest).toHaveBeenCalledWith('projects.tree', expect.objectContaining({ profile: ANCHOR }))
  })

  it('the all-agents view of a support lease keeps the anchor-routed shapes', async () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    selectProfile(SIBLING)
    await settle()
    $showAllProfiles.set(true)

    await searchSessions('invoice')
    await getCronJobs(sidebarProfileForScope($profileScope.get()))

    expect(sent('/api/sessions/search')).not.toHaveProperty('profile')
    expect(queryProfile(sent('/api/cron/jobs'))).toBe('all')
    expect(sent('/api/cron/jobs').profile).toBe(ANCHOR)
  })
})
