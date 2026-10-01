// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCronJob, instantiateAutomationBlueprint } from '@/hermes'
import { $activeGatewayProfile, $profiles, setShowAllProfiles } from '@/store/profile'
import { stubResizeObserver } from '@/test/jsdom'

import { CronView } from './index'

stubResizeObserver()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCronJob: vi.fn(async () => ({ id: 'job-one', name: 'Nightly' })),
  getAutomationBlueprints: vi.fn(async () => ({ blueprints: [] })),
  getCronDeliveryTargets: vi.fn(async () => []),
  getCronJobRuns: vi.fn(async () => []),
  instantiateAutomationBlueprint: vi.fn(async () => ({ id: 'job-blueprint', name: 'Blueprint job' }))
}))

vi.mock('@/lib/model-options', () => ({ requestModelOptions: vi.fn(async () => ({ providers: [] })) }))

vi.mock('./cron-actions', () => ({
  mutateAndRefreshCronJobs: vi.fn(async (_profile: string, mutate: () => Promise<unknown>) => ({
    refreshError: null,
    stale: false,
    value: await mutate()
  })),
  refreshCronJobs: vi.fn(async () => ({ refreshError: null, stale: false })),
  triggerAndRefreshCronJobs: vi.fn()
}))

const profiles = [
  { display_name: 'Atlas Desk', is_default: true, name: 'atlas-desk' },
  { display_name: 'Birch Ops', is_default: false, name: 'birch-ops' }
] as never

function renderCron(blueprints: unknown[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

  queryClient.setQueryData(['cron-blueprints'], blueprints)
  queryClient.setQueryData(['cron-delivery-targets'], [])
  queryClient.setQueryData(['model-options', 'global'], { providers: [] })

  return render(
    <QueryClientProvider client={queryClient}>
      <CronView onClose={vi.fn()} onOpenSession={vi.fn()} setStatusbarItemGroup={vi.fn()} />
    </QueryClientProvider>
  )
}

async function openManualJob() {
  fireEvent.click(await screen.findByRole('button', { name: 'New cron' }))
  await screen.findByText('Creates on Birch Ops')
}

async function submitManualJob() {
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarize the day' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create cron' }))
  await waitFor(() => expect(createCronJob).toHaveBeenCalled())
}

beforeEach(() => {
  vi.mocked(createCronJob).mockClear()
  vi.mocked(instantiateAutomationBlueprint).mockClear()
  $profiles.set(profiles)
  $activeGatewayProfile.set('birch-ops')
})

afterEach(() => {
  cleanup()
  setShowAllProfiles(false)
  $profiles.set([])
  $activeGatewayProfile.set('default')
})

describe('CronView create target', () => {
  it('All view shows the active profile label and explicitly creates there', async () => {
    setShowAllProfiles(true)
    renderCron()

    await openManualJob()
    expect(screen.getByText('Creates on Birch Ops')).toBeTruthy()
    await submitManualJob()
    expect(createCronJob).toHaveBeenCalledWith(expect.any(Object), 'birch-ops')
  })

  it('concrete view keeps the ambient one-argument create call', async () => {
    setShowAllProfiles(false)
    renderCron()

    await openManualJob()
    expect(screen.getByText('Creates on Birch Ops')).toBeTruthy()
    await submitManualJob()
    expect(vi.mocked(createCronJob).mock.calls[0]).toHaveLength(1)
  })

  it('All-view blueprint create targets the active profile instead of the default alias', async () => {
    setShowAllProfiles(true)

    const blueprint = {
      appUrl: '',
      category: 'general',
      command: '',
      description: '',
      fields: [],
      key: 'daily-brief',
      tags: [],
      title: 'Daily brief'
    }

    renderCron([blueprint])

    fireEvent.click(await screen.findByText('Daily brief'))
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule it' }))

    await waitFor(() =>
      expect(instantiateAutomationBlueprint).toHaveBeenCalledWith({ blueprint: 'daily-brief', values: {} }, 'birch-ops')
    )
  })
})
