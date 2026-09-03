import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as Nanostores from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteProfile, getProfileSoul } from '@/hermes'
import { retireLocalProfileGateways } from '@/store/gateway'
import { refreshProfiles, selectProfile, setActiveProfile } from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import { ProfilesView } from './index'

// These tests pin the invariant this whole area exists to hold: the Manage
// Profiles page and the sidebar rail share ONE set of profile dialogs, so both
// "New Profile" entry points render the same modal (SOUL.md included), and
// deleting the profile the gateway is on re-homes to default instead of
// stranding it on a dead backend. The drift that motivated the fix got in
// precisely because nothing rendered this view.

afterEach(cleanup)

const originalHermesDesktop = Object.getOwnPropertyDescriptor(window, 'hermesDesktop')

afterEach(() => {
  if (originalHermesDesktop) {
    Object.defineProperty(window, 'hermesDesktop', originalHermesDesktop)
  } else {
    // @ts-expect-error Test cleanup restores the pre-test absence of the preload bridge.
    delete window.hermesDesktop
  }
})

// Real i18n (useI18n falls back to English with no provider), so labels are the
// actual strings — no brittle key snapshot to maintain here.

// CodeEditor is CodeMirror; the detail pane's SOUL editor doesn't matter to
// these behaviors, so stub it out of the jsdom render.
vi.mock('@/components/chat/code-editor', () => ({
  CodeEditor: () => null
}))

vi.mock('@/hermes', () => ({
  createProfile: vi.fn(async () => ({ name: 'x', ok: true, path: '/x' })),
  deleteProfile: vi.fn(async () => ({ ok: true, path: '/x' })),
  getProfileSoul: vi.fn(async () => ({ content: '', exists: true })),
  renameProfile: vi.fn(async () => ({ name: 'x', ok: true, path: '/x' })),
  updateProfileSoul: vi.fn(async () => ({ ok: true }))
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  retireLocalProfileGateways: vi.fn()
}))

const { $activeGatewayProfile: activeGateway, $profileColors } = vi.hoisted(() => {
  const { atom } = require('nanostores') as typeof Nanostores

  return {
    $activeGatewayProfile: atom<string>('default'),
    $profileColors: atom<Record<string, string>>({})
  }
})

vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: activeGateway,
  $profileColors,
  normalizeProfileKey: (name: null | string | undefined) => (name ?? '').trim() || 'default',
  profileLabel: (profile: { display_name?: string; name: string }) =>
    (profile.display_name ?? '').trim() || profile.name,
  refreshProfiles: vi.fn(async () => [] as ProfileInfo[]),
  selectProfile: vi.fn(),
  setActiveProfile: vi.fn()
}))

// The one non-default profile these tests act on. Its name doubles as the row's
// accessible name, so the delete helper queries by it rather than a literal.
const NAMED_PROFILE = 'work'

function makeProfile(name: string, isDefault = false): ProfileInfo {
  return {
    has_env: false,
    is_default: isDefault,
    model: null,
    name,
    path: `/home/user/.hermes/profiles/${name}`,
    provider: null,
    skill_count: 0
  }
}

// Radix's trigger opens on the pointerdown/up pair, not the synthetic click
// alone — fire the full sequence a real click produces.
function realClick(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(el, { button: 0, pointerType: 'mouse' })
  fireEvent.click(el)
}

// ProfilesView loads its list in a mount effect (refreshProfiles → setProfiles),
// so the first paint is the loader and the rows commit a microtask later. Flush
// that inside act() so the rows exist before anything queries them, and so the
// mount setState isn't left unwrapped.
async function renderProfilesView() {
  await act(async () => {
    render(<ProfilesView onClose={vi.fn()} />)
  })
}

// PanelListRow labels BOTH the row's select target and its kebab with the
// profile name (`menuLabel={profile.name}`), so the name alone matches two
// buttons. Only the kebab is a menu trigger, so `expanded` disambiguates.
function findRowMenu(profileName: string) {
  return screen.findByRole('button', { expanded: false, name: profileName })
}

// Open the (only non-default) row's actions menu → Delete → confirm. The
// confirm click kicks off an async chain (deleteProfile → onDeleted refresh →
// setProfiles, plus the re-home writes), so settle it inside act() to flush
// those updates deterministically instead of leaking them past the assertions.
async function deleteTheNamedProfile() {
  realClick(await findRowMenu(NAMED_PROFILE))
  fireEvent.click(await screen.findByRole('menuitem', { name: /delete/i }))
  const confirm = await screen.findByRole('button', { name: 'Delete' })
  await act(async () => {
    fireEvent.click(confirm)
  })
}

describe('ProfilesView', () => {
  it('renders the authorized managed label while profile operations retain the canonical id', async () => {
    const canonicalProfile = 'e-managed-profile'

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: {
          status: vi.fn().mockResolvedValue({
            agentDisplayName: 'Asuka',
            agentId: 'enrollment-agent-id',
            managed: true
          })
        },
        profile: {
          get: vi.fn().mockResolvedValue({ profile: canonicalProfile })
        }
      }
    })
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile(canonicalProfile)])

    await renderProfilesView()

    expect(await screen.findByRole('heading', { name: 'Asuka' })).toBeTruthy()
    expect(await screen.findAllByRole('button', { name: 'Asuka' })).toHaveLength(2)
    await waitFor(() => expect(getProfileSoul).toHaveBeenCalledWith(canonicalProfile))
  })

  it('reads display metadata after the active profile and retains the last valid label on refresh failure', async () => {
    const canonicalProfile = 'e-managed-profile'
    const callOrder: string[] = []

    const getProfile = vi
      .fn()
      .mockImplementationOnce(async () => {
        callOrder.push('profile')

        return { profile: canonicalProfile }
      })
      .mockRejectedValueOnce(new Error('transient profile read failure'))

    const getStatus = vi.fn().mockImplementation(async () => {
      callOrder.push('status')

      return { agentDisplayName: 'Asuka', managed: true }
    })

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: { status: getStatus },
        profile: { get: getProfile }
      }
    })
    vi.mocked(refreshProfiles).mockImplementation(async () => {
      callOrder.push('list')

      return [makeProfile(canonicalProfile)]
    })

    await renderProfilesView()

    expect(await screen.findByRole('heading', { name: 'Asuka' })).toBeTruthy()
    expect(callOrder).toEqual(['list', 'profile', 'status'])

    fireEvent.keyDown(window, { key: 'r' })
    await waitFor(() => expect(getProfile).toHaveBeenCalledTimes(2))
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('heading', { name: 'Asuka' })).toBeTruthy()
  })

  it('coalesces overlapping managed refreshes before enrollment reads', async () => {
    const canonicalProfile = 'e-managed-profile'
    let resolveFirstProfile: ((value: { profile: string }) => void) | undefined

    vi.mocked(refreshProfiles).mockClear()

    const getProfile = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ profile: string }>(resolve => {
            resolveFirstProfile = resolve
          })
      )

    const getStatus = vi.fn().mockResolvedValue({ agentDisplayName: 'Asuka current', managed: true })

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        eva: { status: getStatus },
        profile: { get: getProfile }
      }
    })
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile(canonicalProfile)])

    render(<ProfilesView onClose={vi.fn()} />)
    await waitFor(() => expect(getProfile).toHaveBeenCalledTimes(1))

    fireEvent.keyDown(window, { key: 'r' })
    expect(getProfile).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstProfile?.({ profile: canonicalProfile })
    })
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1))

    expect(await screen.findByRole('heading', { name: 'Asuka current' })).toBeTruthy()
    expect(refreshProfiles).toHaveBeenCalledTimes(1)
  })

  it('opens the shared create dialog with the SOUL.md field (parity with the rail)', async () => {
    vi.mocked(refreshProfiles).mockResolvedValue([])

    await renderProfilesView()

    realClick(await screen.findByRole('button', { name: 'New profile' }))

    const soul = await screen.findByLabelText(/SOUL\.md/i)

    expect(soul.tagName).toBe('TEXTAREA')
    expect(soul.getAttribute('id')).toBe('new-profile-soul')
  })

  it('re-homes to default when the active profile is deleted', async () => {
    const deleteProfileMock = vi.mocked(deleteProfile)
    const retireLocalProfileGatewaysMock = vi.mocked(retireLocalProfileGateways)

    deleteProfileMock.mockClear()
    retireLocalProfileGatewaysMock.mockClear()
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true), makeProfile(NAMED_PROFILE)])
    activeGateway.set(NAMED_PROFILE)

    await renderProfilesView()
    await deleteTheNamedProfile()

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith(NAMED_PROFILE))
    expect(retireLocalProfileGateways).toHaveBeenCalledWith(NAMED_PROFILE)
    expect(retireLocalProfileGatewaysMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteProfileMock.mock.invocationCallOrder[0]
    )
    await waitFor(() => expect(selectProfile).toHaveBeenCalledWith('default'))
    expect(setActiveProfile).toHaveBeenCalledWith('default')
  })

  it('leaves the active profile alone when a different profile is deleted', async () => {
    vi.mocked(selectProfile).mockClear()
    vi.mocked(setActiveProfile).mockClear()
    vi.mocked(refreshProfiles).mockResolvedValue([makeProfile('default', true), makeProfile(NAMED_PROFILE)])
    activeGateway.set('default')

    await renderProfilesView()
    await deleteTheNamedProfile()

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith(NAMED_PROFILE))
    // The dialog closes once the delete settles; a non-active delete must not re-home.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull())
    expect(selectProfile).not.toHaveBeenCalled()
    expect(setActiveProfile).not.toHaveBeenCalled()
  })
})
