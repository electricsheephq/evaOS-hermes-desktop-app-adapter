import { beforeEach, describe, expect, it } from 'vitest'

import { removeCronJobRow, replaceCronJobRow } from '../app/chat/sidebar/cron-jobs-section'
import type { CronJob } from '../types/hermes'

import {
  $cronJobErrors,
  $cronJobs,
  beginCronJobsRequest,
  commitCronJobsRequest,
  setCronJobs,
  updateCronJobs
} from './cron'

const oldJob = { id: 'old' } as never
const newJob = { id: 'new' } as never

describe('cron jobs request fencing', () => {
  beforeEach(() => {
    setCronJobs([])
  })

  it('rejects an older refresh after a newer refresh commits', () => {
    const older = beginCronJobsRequest('all')
    const newer = beginCronJobsRequest('all')

    expect(commitCronJobsRequest(newer, [newJob])).toBe(true)
    expect(commitCronJobsRequest(older, [oldJob])).toBe(false)
    expect($cronJobs.get()).toEqual([newJob])
  })

  it('rejects a refresh from the previous profile scope', () => {
    const work = beginCronJobsRequest('work')

    beginCronJobsRequest('personal')

    expect(commitCronJobsRequest(work, [oldJob])).toBe(false)
    expect($cronJobs.get()).toEqual([])
  })

  it('rejects an in-flight poll after a local mutation', () => {
    const poll = beginCronJobsRequest('all')

    updateCronJobs(() => [newJob])

    expect(commitCronJobsRequest(poll, [oldJob])).toBe(false)
    expect($cronJobs.get()).toEqual([newJob])
  })

  it('publishes partial profile errors with the healthy cron rows', () => {
    const request = beginCronJobsRequest('all')

    const jobs = Object.assign([newJob], {
      errors: [{ error: 'Profile temporarily unavailable.', profile: 'beta', status: 502 }]
    })

    expect(commitCronJobsRequest(request, jobs)).toBe(true)
    expect($cronJobs.get()).toEqual([newJob])
    expect($cronJobErrors.get()).toEqual([{ error: 'Profile temporarily unavailable.', profile: 'beta', status: 502 }])
  })

  it('keeps prior rows for an unavailable profile and clears errors after recovery', () => {
    const alpha = { enabled: true, id: 'daily-alpha', profile: 'alpha' } satisfies CronJob
    const beta = { enabled: true, id: 'daily-beta', profile: 'beta' } satisfies CronJob
    setCronJobs([alpha, beta])

    const partial = Object.assign([{ ...alpha, name: 'Fresh alpha' }], {
      errors: [{ error: 'Profile temporarily unavailable.', profile: 'beta', status: 404 }]
    })

    expect(commitCronJobsRequest(beginCronJobsRequest('all'), partial)).toBe(true)
    expect($cronJobs.get()).toEqual([{ ...alpha, name: 'Fresh alpha' }, beta])
    expect($cronJobErrors.get()).toEqual(partial.errors)

    expect(commitCronJobsRequest(beginCronJobsRequest('all'), [alpha, beta])).toBe(true)
    expect($cronJobErrors.get()).toEqual([])
  })

  it('does not keep prior rows for an explicitly refused profile', () => {
    const alpha = { enabled: true, id: 'daily-alpha', profile: 'alpha' } satisfies CronJob
    const beta = { enabled: true, id: 'daily-beta', profile: 'beta' } satisfies CronJob
    setCronJobs([alpha, beta])

    const refused = Object.assign([alpha], {
      errors: [
        { code: 'support-profile-refused', error: 'Profile temporarily unavailable.', profile: 'beta', status: 403 }
      ]
    })

    expect(commitCronJobsRequest(beginCronJobsRequest('all'), refused)).toBe(true)
    expect($cronJobs.get()).toEqual([alpha])
  })
})

describe('cron job identity', () => {
  it('mutates and deletes only the selected profile when job ids match', () => {
    const alpha = { enabled: true, id: 'daily', profile: 'alpha', state: 'scheduled' } satisfies CronJob
    const beta = { enabled: true, id: 'daily', profile: 'beta', state: 'scheduled' } satisfies CronJob
    const alphaSnapshot = structuredClone(alpha)
    setCronJobs([alpha, beta])

    updateCronJobs(rows => replaceCronJobRow(rows, beta, { ...beta, state: 'paused' }))
    expect($cronJobs.get()[0]).toBe(alpha)
    expect($cronJobs.get()[0]).toEqual(alphaSnapshot)
    expect($cronJobs.get()[1]).toEqual({ ...beta, state: 'paused' })

    updateCronJobs(rows => removeCronJobRow(rows, beta))
    expect($cronJobs.get()).toEqual([alphaSnapshot])
  })
})
