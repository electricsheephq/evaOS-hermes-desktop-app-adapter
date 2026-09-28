import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/hermes'
import { refreshProfiles } from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

import { ProfilesView } from './index'

// #396: a managed gateway serves exactly its own profile, so the Profiles page
// must pin each profile's SOUL.md read/write to that profile instead of the
// bound one. These tests drive the real api/ helpers and assert the IPC request
// each profile's call carries.

vi.mock('@/components/chat/code-editor', () => ({
  CodeEditor: ({ initialValue, onChange }: { initialValue: string; onChange: (value: string) => void }) => (
    <textarea aria-label="SOUL.md editor" defaultValue={initialValue} onChange={e => onChange(e.target.value)} />
  )
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  retireLocalProfileGateways: vi.fn()
}))

vi.mock('@/store/profile', async () => {
  const { atom } = await import('nanostores')

  return {
    $activeGatewayProfile: atom<string>('alpha'),
    $profileColors: atom<Record<string, string>>({}),
    $showAllProfiles: atom<boolean>(false),
    normalizeProfileKey: (name: null | string | undefined) => (name ?? '').trim() || 'default',
    profileLabel: (profile: { display_name?: string; name: string }) =>
      (profile.display_name ?? '').trim() || profile.name,
    refreshProfiles: vi.fn(async () => [] as ProfileInfo[]),
    selectProfile: vi.fn(),
    setActiveProfile: vi.fn()
  }
})

// alpha is the profile this session is bound to; bravo is a scoped sibling.
const BOUND = 'alpha'
const SIBLING = 'bravo'
const CONNECTION = 'eva-managed-runtime'

interface ApiRequest {
  body?: unknown
  connectionId?: string
  method?: string
  path: string
  profile?: string
}

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

const api = vi.fn(async (_request: ApiRequest): Promise<unknown> => ({ content: '', exists: true, ok: true }))

function soulRequests() {
  return api.mock.calls
    .map(([request]) => request)
    .filter(request => request.path.endsWith('/soul'))
    .map(({ connectionId, method, path, profile }) => ({ connectionId, method: method ?? 'GET', path, profile }))
}

async function renderProfilesView() {
  await act(async () => {
    render(<ProfilesView onClose={vi.fn()} />)
  })
}

// Outside managed mode the row's kebab shares the row's name; select the row
// button, which is not a menu trigger.
async function selectProfileRow(name: string) {
  const rows = await screen.findAllByRole('button', { name })
  const row = rows.find(button => !button.hasAttribute('aria-expanded'))

  await act(async () => {
    fireEvent.click(row!)
  })
}

async function editAndSaveSoul(content: string) {
  fireEvent.change(await screen.findByLabelText('SOUL.md editor'), { target: { value: content } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save SOUL.md' }))
  })
}

beforeEach(() => {
  api.mockClear()
  vi.mocked(refreshProfiles).mockResolvedValue([makeProfile(BOUND, true), makeProfile(SIBLING)])
  // The ambient scope the bound session sets: every untagged request would go
  // to the bound profile on the managed connection.
  setApiRequestConnection(CONNECTION)
  setApiRequestProfile(BOUND)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setApiRequestConnection(null)
  setApiRequestProfile(null)
})

describe('ProfilesView per-profile routing in managed mode (#396)', () => {
  it('pins SOUL.md reads and writes for the bound and the sibling profile to that profile', async () => {
    vi.stubGlobal('hermesDesktop', { api, eva: {} })

    await renderProfilesView()
    await waitFor(() => expect(soulRequests()).toHaveLength(1))
    await editAndSaveSoul('bound soul')

    await selectProfileRow(SIBLING)
    await waitFor(() => expect(soulRequests()).toHaveLength(3))
    await editAndSaveSoul('sibling soul')

    expect(soulRequests()).toEqual([
      { connectionId: CONNECTION, method: 'GET', path: `/api/profiles/${BOUND}/soul`, profile: BOUND },
      { connectionId: CONNECTION, method: 'PUT', path: `/api/profiles/${BOUND}/soul`, profile: BOUND },
      { connectionId: CONNECTION, method: 'GET', path: `/api/profiles/${SIBLING}/soul`, profile: SIBLING },
      { connectionId: CONNECTION, method: 'PUT', path: `/api/profiles/${SIBLING}/soul`, profile: SIBLING }
    ])
    expect(api.mock.calls.at(-1)?.[0].body).toEqual({ content: 'sibling soul' })
  })

  it('says the profile gateway is not reachable instead of the raw 403', async () => {
    api.mockImplementation(async request => {
      if (request.profile === SIBLING) {
        throw new Error(
          'Error invoking remote method \'hermes:api\': Error: 403: {"detail":"profile is not authorized"}'
        )
      }

      return { content: '', exists: true, ok: true }
    })
    vi.stubGlobal('hermesDesktop', { api, eva: {} })

    await renderProfilesView()
    await selectProfileRow(SIBLING)

    expect(await screen.findByText("This profile's gateway is not reachable in this session")).toBeTruthy()
    expect(screen.queryByText(/profile is not authorized/)).toBeNull()
  })

  it('shows a 5xx SOUL.md failure raw instead of the unreachable message', async () => {
    const failure = '500: {"detail":"Failed to read SOUL.md: [Errno 13] Permission denied"}'

    api.mockImplementation(async request => {
      if (request.profile === SIBLING) {
        throw new Error(failure)
      }

      return { content: '', exists: true, ok: true }
    })
    vi.stubGlobal('hermesDesktop', { api, eva: {} })

    await renderProfilesView()
    await selectProfileRow(SIBLING)

    expect(await screen.findByText(failure)).toBeTruthy()
    expect(screen.queryByText("This profile's gateway is not reachable in this session")).toBeNull()
  })

  it('keeps the upstream ambient scope and error text outside managed mode', async () => {
    api.mockImplementation(async request => {
      if (request.path === `/api/profiles/${SIBLING}/soul`) {
        throw new Error('403: {"detail":"profile is not authorized"}')
      }

      return { content: '', exists: true, ok: true }
    })
    vi.stubGlobal('hermesDesktop', { api })

    await renderProfilesView()
    await selectProfileRow(SIBLING)

    expect(await screen.findByText('403: {"detail":"profile is not authorized"}')).toBeTruthy()
    expect(soulRequests()).toEqual([
      { connectionId: CONNECTION, method: 'GET', path: `/api/profiles/${BOUND}/soul`, profile: BOUND },
      { connectionId: CONNECTION, method: 'GET', path: `/api/profiles/${SIBLING}/soul`, profile: BOUND }
    ])
  })
})
