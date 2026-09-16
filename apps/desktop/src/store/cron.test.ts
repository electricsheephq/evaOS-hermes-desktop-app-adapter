import { beforeEach, describe, expect, it } from 'vitest'

import {
  $cronJobErrors,
  $cronJobs,
  beginCronJobsRequest,
  commitCronJobsRequest,
  cronJobIdentity,
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
})

describe('cron job identity', () => {
  it('separates same-id jobs owned by different profiles', () => {
    expect(cronJobIdentity({ id: 'daily', profile: 'alpha' })).not.toBe(
      cronJobIdentity({ id: 'daily', profile: 'beta' })
    )
  })
})
