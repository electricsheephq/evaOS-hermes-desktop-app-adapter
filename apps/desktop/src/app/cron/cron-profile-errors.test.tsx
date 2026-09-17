// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $cronJobErrors, setCronJobs } from '@/store/cron'

import { CronView } from './index'

vi.mock('./cron-actions', () => ({
  mutateAndRefreshCronJobs: vi.fn(),
  refreshCronJobs: vi.fn(async () => ({ stale: false })),
  triggerAndRefreshCronJobs: vi.fn()
}))

afterEach(() => {
  cleanup()
  setCronJobs([])
})

describe('CronView profile errors', () => {
  it('shows failed profile reads when no jobs load', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    queryClient.setQueryData(['cron-blueprints'], [])
    setCronJobs([])
    $cronJobErrors.set([{ error: 'Profile temporarily unavailable.', profile: 'beta', status: 502 }])

    render(
      <QueryClientProvider client={queryClient}>
        <CronView onClose={vi.fn()} onOpenSession={vi.fn()} setStatusbarItemGroup={vi.fn()} />
      </QueryClientProvider>
    )

    await waitFor(() => expect(screen.queryByLabelText('Loading cron jobs...')).toBeNull())
    expect(screen.getByText('1 profile could not be read: beta: 502')).toBeTruthy()
  })

  it('names a failed profile without rendering main-process English prose', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

    queryClient.setQueryData(['cron-blueprints'], [])
    setCronJobs([])
    $cronJobErrors.set([{ error: 'Profile temporarily unavailable.', profile: 'beta' }])

    render(
      <QueryClientProvider client={queryClient}>
        <CronView onClose={vi.fn()} onOpenSession={vi.fn()} setStatusbarItemGroup={vi.fn()} />
      </QueryClientProvider>
    )

    await waitFor(() => expect(screen.queryByLabelText('Loading cron jobs...')).toBeNull())
    expect(screen.getByRole('status').textContent).toContain('beta')
    expect(screen.getByRole('status').textContent).not.toContain('temporarily unavailable')
  })
})
