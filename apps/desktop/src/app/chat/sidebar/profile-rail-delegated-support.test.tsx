import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'
import type { ProfileInfo } from '@/types/hermes'

// #347: in customer-wide ("All authorized agents") delegated support the
// gateway stays pinned to the lease's anchor profile (#285), while a rail pick
// still points the next new chat at the clicked sibling. The rail highlight and
// the sidebar's session-list scope must follow that pick — the profile the
// send path will create the chat in — never the anchor. This renders the real
// rail over the REAL profile store; only its I/O seams are stubbed.

const ensureGatewayForProfile = vi.fn(async (_profile: string) => undefined)

vi.mock('@/store/gateway', () => ({
  $gateway: atom<unknown>({ id: 'live-socket', connectionState: 'open' }),
  activeGatewayConnectionId: () => null,
  activeGatewayProfileKey: () => ensureGatewayForProfile.mock.lastCall?.[0] ?? 'default',
  ensureGatewayForAgent: vi.fn(async () => true),
  ensureGatewayForProfile,
  openGatewayForAgent: vi.fn(async () => undefined),
  openGatewayForProfile: vi.fn(async () => undefined),
  openSecondaryCount: () => 0,
  primaryGatewayConnectionId: () => null
}))
vi.mock('@/store/pool-limits', async () => {
  const { atom } = await import('nanostores')

  return { $poolLimits: atom({ idleMs: 600_000, maxBackends: 3 }) }
})
vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getProfileSoul: vi.fn().mockResolvedValue({ content: '' }),
  setApiRequestProfile: vi.fn(),
  updateProfileSoul: vi.fn()
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph: vi.fn() }))

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel' },
      profiles: {
        allAuthorizedAgents: 'All authorized agents',
        allProfiles: 'All profiles',
        connectGateway: 'Manage gateways…',
        importProfile: 'Import profile…',
        manageProfiles: 'Manage profiles…',
        newProfile: 'New profile',
        remoteOverride: { badge: (host: string) => `Runs on ${host}`, menuItem: 'Connect to a remote host…' },
        showAllProfiles: 'Show all profiles',
        switchToProfile: (name: string) => `Switch to ${name}`,
        title: 'Profiles'
      }
    }
  })
}))

vi.mock('@/store/connections', () => ({
  $activeConnectionId: atom(null),
  $connectionsRegistry: atom(null),
  $hasMultipleConnections: atom(false),
  selectConnection: vi.fn()
}))
vi.mock('@/store/profile-share', () => ({ runExportProfileFlow: vi.fn(), runImportProfileFlow: vi.fn() }))
vi.mock('./use-profile-prewarm', () => ({
  useProfilePrewarm: () => ({ cancelPrewarm: vi.fn(), notePointerMove: vi.fn(), startPrewarm: vi.fn() })
}))
vi.mock('./use-profile-rail-refresh-on-active', () => ({ useProfileRailRefreshOnActive: () => undefined }))
vi.mock('@/components/chat/code-editor', () => ({ CodeEditor: () => null }))
vi.mock('../../profiles/create-profile-dialog', () => ({ CreateProfileDialog: () => null }))
vi.mock('../../profiles/delete-profile-dialog', () => ({ DeleteProfileDialog: () => null }))
vi.mock('../../profiles/rename-profile-dialog', () => ({ RenameProfileDialog: () => null }))

const {
  $activeGatewayProfile,
  $newChatProfile,
  $profileScope,
  $profiles,
  $showAllProfiles,
  adoptActiveGatewayProfile,
  cycleProfile,
  resolveNewChatOwnerRoute,
  selectProfile,
  sidebarProfileForScope,
  switchToDefaultProfile
} = await import('@/store/profile')

const { ProfileRail } = await import('./profile-switcher')

// Synthetic profile ids only — this repo is public.
const ANCHOR = 'agent-alpha'
const SIBLING = 'agent-bravo'
const THIRD = 'agent-charlie'

const profile = (name: string): ProfileInfo => ({
  has_env: false,
  is_default: false,
  model: null,
  name,
  path: `/srv/hermes/${name}`,
  provider: null,
  skill_count: 0
})

// The profile a new chat's session.create carries, read from the same atoms
// and in the same precedence desktopSessionCreateParams uses
// (capturedRoute.profile → $newChatProfile → $activeGatewayProfile).
const sendPathProfile = (): string =>
  resolveNewChatOwnerRoute()?.profile ?? ($newChatProfile.get() || $activeGatewayProfile.get())

const pressed = (name: string): boolean => screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true'

const clickSquare = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
    // Let the fire-and-forget activation settle before asserting.
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ensureGatewayForProfile.mockClear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    getConnection: vi.fn(async (name?: string) => ({ baseUrl: '', mode: 'local', profile: name }) as HermesConnection)
  }
  $showAllProfiles.set(false)
  $newChatProfile.set(null)
})

afterEach(() => {
  cleanup()
  adoptActiveGatewayProfile('default', false)
  $newChatProfile.set(null)
  $profiles.set([])
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('ProfileRail under customer-wide delegated support (#347)', () => {
  it('moves the rail highlight and the sidebar scope to the picked sibling, the profile the send path uses', async () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([profile(ANCHOR), profile(SIBLING)])
    render(<ProfileRail />)

    expect(pressed(ANCHOR)).toBe(true)
    expect(pressed(SIBLING)).toBe(false)

    await clickSquare(SIBLING)

    // The gateway stays on the lease anchor (#285 lock) — routing is untouched.
    expect($activeGatewayProfile.get()).toBe(ANCHOR)
    expect(ensureGatewayForProfile).not.toHaveBeenCalled()
    // …while the next message goes to the sibling.
    expect(sendPathProfile()).toBe(SIBLING)

    // The rail and the sidebar list follow that same profile.
    expect(pressed(SIBLING)).toBe(true)
    expect(pressed(ANCHOR)).toBe(false)
    expect($profileScope.get()).toBe(SIBLING)
    expect(sidebarProfileForScope($profileScope.get())).toBe(sendPathProfile())

    // Picking the anchor again brings all three back together.
    await clickSquare(ANCHOR)

    expect(sendPathProfile()).toBe(ANCHOR)
    expect(pressed(ANCHOR)).toBe(true)
    expect(pressed(SIBLING)).toBe(false)
    expect($profileScope.get()).toBe(ANCHOR)
  })

  it('falls back with the send path: a plain new chat (cleared intent) goes to the anchor, and so do the rail and list', async () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([profile(ANCHOR), profile(SIBLING)])
    render(<ProfileRail />)

    await clickSquare(SIBLING)
    expect($profileScope.get()).toBe(SIBLING)

    act(() => $newChatProfile.set(null))

    expect(sendPathProfile()).toBe(ANCHOR)
    expect($profileScope.get()).toBe(ANCHOR)
    expect(pressed(ANCHOR)).toBe(true)
    expect(pressed(SIBLING)).toBe(false)
  })

  it('keeps the all-agents view on the all scope', async () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([profile(ANCHOR), profile(SIBLING)])
    $newChatProfile.set(SIBLING)
    $showAllProfiles.set(true)
    render(<ProfileRail />)

    expect(sidebarProfileForScope($profileScope.get())).toBe('all')
    expect(pressed(ANCHOR)).toBe(false)
    expect(pressed(SIBLING)).toBe(false)
  })
})

describe('keyboard and lease transitions under customer-wide delegated support (#347)', () => {
  it('⌘D lands on the lease anchor when the grant has no default profile, never on the bare alias', async () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([profile(ANCHOR), profile(SIBLING)])
    render(<ProfileRail />)

    await clickSquare(SIBLING)
    expect(pressed(SIBLING)).toBe(true)

    act(() => switchToDefaultProfile())

    expect($newChatProfile.get()).toBe(ANCHOR)
    expect($profileScope.get()).toBe(ANCHOR)
    expect(pressed(ANCHOR)).toBe(true)
    expect(pressed(SIBLING)).toBe(false)
    expect(sendPathProfile()).toBe(ANCHOR)
  })

  it('⌘D picks the default profile when the grant includes it', () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([{ ...profile('default'), is_default: true }, profile(ANCHOR)])

    switchToDefaultProfile()

    expect($profileScope.get()).toBe('default')
  })

  it('a new lease starts on its anchor; re-adopting the same lease keeps the pick', () => {
    // A stale intent from the window's previous context.
    adoptActiveGatewayProfile(ANCHOR, false)
    $newChatProfile.set(SIBLING)

    adoptActiveGatewayProfile(ANCHOR, true)
    expect($profileScope.get()).toBe(ANCHOR)

    $profiles.set([profile(ANCHOR), profile(SIBLING), profile(THIRD)])
    selectProfile(SIBLING)
    adoptActiveGatewayProfile(ANCHOR, true)
    expect($profileScope.get()).toBe(SIBLING)

    adoptActiveGatewayProfile(THIRD, true)
    expect($profileScope.get()).toBe(THIRD)
  })

  it('profile cycling steps from the picked sibling, not from the anchor', () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([profile(ANCHOR), profile(SIBLING), profile(THIRD)])

    cycleProfile(1)
    expect($profileScope.get()).toBe(SIBLING)

    cycleProfile(1)
    expect($profileScope.get()).toBe(THIRD)
  })
})

describe('ProfileRail outside delegated support (unchanged)', () => {
  it('ordinary multi-profile picks still follow the swapped gateway', async () => {
    adoptActiveGatewayProfile(ANCHOR, false)
    $profiles.set([profile(ANCHOR), profile(SIBLING)])
    render(<ProfileRail />)

    await clickSquare(SIBLING)
    await act(async () => {
      await vi.waitFor(() => expect($activeGatewayProfile.get()).toBe(SIBLING))
    })

    expect(ensureGatewayForProfile).toHaveBeenCalledWith(SIBLING)
    expect($profileScope.get()).toBe(SIBLING)
    expect(pressed(SIBLING)).toBe(true)
    expect(pressed(ANCHOR)).toBe(false)
  })

  it('an ordinary new-chat intent does not move the rail off the live gateway profile', () => {
    adoptActiveGatewayProfile(ANCHOR, false)
    $profiles.set([profile(ANCHOR), profile(SIBLING)])
    $newChatProfile.set(SIBLING)
    render(<ProfileRail />)

    expect($profileScope.get()).toBe(ANCHOR)
    expect(pressed(ANCHOR)).toBe(true)
    expect(pressed(SIBLING)).toBe(false)
  })

  it('a single-agent support lease keeps the rail on its granted profile', () => {
    adoptActiveGatewayProfile(ANCHOR, true)
    $profiles.set([profile(ANCHOR)])
    render(<ProfileRail />)

    expect($profileScope.get()).toBe(ANCHOR)
    expect(sendPathProfile()).toBe(ANCHOR)
  })
})
