import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cronJobIdentity } from '@/store/cron'
import type { CronJob } from '@/types/hermes'

import { removeCronJobRow, replaceCronJobRow, SidebarCronJobsSection } from './cron-jobs-section'

afterEach(cleanup)

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

  it('keeps same-id jobs isolated by profile during updates, deletion, and triggering', () => {
    const alpha = { enabled: true, id: 'shared-job', profile: 'alpha', state: 'scheduled' } satisfies CronJob
    const beta = { enabled: true, id: 'shared-job', profile: 'beta', state: 'scheduled' } satisfies CronJob
    const paused = replaceCronJobRow([alpha, beta], beta, { ...beta, state: 'paused' })

    expect(paused).toEqual([alpha, { ...beta, state: 'paused' }])
    expect(removeCronJobRow(paused, beta)).toEqual([alpha])
    expect(cronJobIdentity(alpha)).not.toBe(cronJobIdentity(beta))
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
})
