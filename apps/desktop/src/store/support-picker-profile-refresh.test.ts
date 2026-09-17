// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

import type { EvaManagedStatus } from '@/global'
import type { ProfileInfo } from '@/types/hermes'

const getProfiles = vi.hoisted(() => vi.fn())
const hermesApi = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return { ...actual, getProfiles, hermesApi }
})

const { $activeGatewayProfile, $profiles, refreshProfiles } = await import('./profile')
const { $evaManagedStatus } = await import('./support-picker')

function profile(name: string): ProfileInfo {
  return {
    has_env: false,
    is_default: false,
    model: null,
    name,
    path: `/tmp/hermes/${name}`,
    provider: null,
    skill_count: 0
  }
}

function status(profileScopeKey: string): EvaManagedStatus {
  return {
    agentId: 'atlas-desk',
    customerId: 'fixture-tenant',
    desktopSessionActive: true,
    desktopSessionExpiresAt: '2030-01-01T00:00:00.000Z',
    email: 'member@example.invalid',
    managed: true,
    productName: 'evaOS Agent',
    profileScopeKey,
    runtimeSessionActive: true,
    runtimeSessionExpiresAt: '2030-01-01T00:00:00.000Z',
    signedOut: false,
    updateChannel: 'stable'
  }
}

beforeEach(async () => {
  getProfiles.mockReset()
  hermesApi.mockReset()
  hermesApi.mockResolvedValue({ active: 'alpha', current: 'alpha' })
  $activeGatewayProfile.set('alpha')
  $profiles.set([])
  $evaManagedStatus.set(null)
  $evaManagedStatus.set(status('alpha|0|alpha'))
  await vi.dynamicImportSettled()
})

it('fetches fresh profile rows after an in-flight pre-scope refresh completes', async () => {
  let resolveOld!: (value: { profiles: ProfileInfo[] }) => void

  const oldResponse = new Promise<{ profiles: ProfileInfo[] }>(resolve => {
    resolveOld = resolve
  })

  getProfiles.mockImplementationOnce(async () => oldResponse).mockResolvedValueOnce({ profiles: [profile('alpha')] })

  const oldFlight = refreshProfiles()

  expect(getProfiles).toHaveBeenCalledOnce()

  $evaManagedStatus.set(status('alpha,beta|1|alpha'))
  await vi.dynamicImportSettled()
  expect(getProfiles).toHaveBeenCalledOnce()

  resolveOld({ profiles: [profile('alpha'), profile('beta')] })
  await oldFlight

  await vi.waitFor(() => expect(getProfiles).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect($profiles.get().map(row => row.name)).toEqual(['alpha']))
})
