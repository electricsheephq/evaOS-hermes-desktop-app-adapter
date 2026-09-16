import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { SidebarCronJobsSection } from './cron-jobs-section'

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
})
