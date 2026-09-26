import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { SidebarCronJobsSection } from './cron-jobs-section'

afterEach(() => {
  cleanup()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('SidebarCronJobsSection', () => {
  it('renders healthy jobs beside a visible partial-profile failure', () => {
    const jobs: CronJob[] = [{ enabled: true, id: 'job-gamma', name: 'Gamma job', profile: 'gamma' }]

    render(
      <SidebarCronJobsSection
        errors={[{ error: 'Profile temporarily unavailable.', profile: 'beta', status: 502 }]}
        jobs={jobs}
        label="Scheduled jobs"
        onManageJob={vi.fn()}
        onOpenRun={vi.fn()}
        onToggle={vi.fn()}
        onTriggerJob={vi.fn()}
        open
      />
    )

    expect(screen.getByRole('status').textContent).toContain('1 profile could not be read: beta: 502')
    expect(screen.getByText('Gamma job')).toBeTruthy()
  })

  it('names a failed profile without rendering main-process English prose', () => {
    render(
      <SidebarCronJobsSection
        errors={[{ error: 'Profile temporarily unavailable.', profile: 'beta' }]}
        jobs={[]}
        label="Scheduled jobs"
        onManageJob={vi.fn()}
        onOpenRun={vi.fn()}
        onToggle={vi.fn()}
        onTriggerJob={vi.fn()}
        open
      />
    )

    expect(screen.getByRole('status').textContent).toContain('beta')
    expect(screen.getByRole('status').textContent).not.toContain('temporarily unavailable')
  })

  it('keeps the alpha trigger idle while a same-id beta job is busy', async () => {
    const alpha = { enabled: true, id: 'shared-job', name: 'Alpha job', profile: 'alpha' } satisfies CronJob
    const beta = { enabled: true, id: 'shared-job', name: 'Beta job', profile: 'beta' } satisfies CronJob

    let release: () => void = () => {}

    const onTriggerJob = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = () => resolve()
        })
    )

    render(
      <SidebarCronJobsSection
        errors={[]}
        jobs={[alpha, beta]}
        label="Scheduled jobs"
        onManageJob={vi.fn()}
        onOpenRun={vi.fn()}
        onToggle={vi.fn()}
        onTriggerJob={onTriggerJob}
        open
      />
    )

    const triggers = screen.getAllByRole('button', { name: 'Trigger now' })
    fireEvent.click(triggers[1])
    await waitFor(() => expect((triggers[1] as HTMLButtonElement).disabled).toBe(true))
    expect((triggers[0] as HTMLButtonElement).disabled).toBe(false)
    expect(onTriggerJob).toHaveBeenCalledWith(beta)
    release()
    await waitFor(() => expect((triggers[1] as HTMLButtonElement).disabled).toBe(false))
  })

  it('passes the selected profile with a same-id job to management', () => {
    const alpha = { enabled: true, id: 'shared-job', name: 'Alpha job', profile: 'alpha' } satisfies CronJob
    const beta = { enabled: true, id: 'shared-job', name: 'Beta job', profile: 'beta' } satisfies CronJob
    const onManageJob = vi.fn()

    render(
      <SidebarCronJobsSection
        errors={[]}
        jobs={[alpha, beta]}
        label="Scheduled jobs"
        onManageJob={onManageJob}
        onOpenRun={vi.fn()}
        onToggle={vi.fn()}
        onTriggerJob={vi.fn()}
        open
      />
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[1])
    expect(onManageJob).toHaveBeenCalledWith(beta)
  })

  it('routes a beta row run-history request through the beta query path', async () => {
    const api = vi.fn(async (_request: { path: string }) => [] as never)

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { api }
    const beta = { enabled: true, id: 'shared-job', name: 'Beta job', profile: 'beta' } satisfies CronJob

    render(
      <SidebarCronJobsSection
        errors={[]}
        jobs={[beta]}
        label="Scheduled jobs"
        onManageJob={vi.fn()}
        onOpenRun={vi.fn()}
        onToggle={vi.fn()}
        onTriggerJob={vi.fn()}
        open
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show runs' }))
    await waitFor(() =>
      expect(api.mock.calls.at(-1)?.[0].path).toBe('/api/cron/jobs/shared-job/runs?limit=5&profile=beta')
    )
  })
})
