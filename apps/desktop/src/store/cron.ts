import { atom } from 'nanostores'

import { stripIpcErrorPrefix } from '@/lib/ipc-error'
import type { CronJob, CronJobList, ProfileReadError } from '@/types/hermes'

export const cronJobIdentity = (job: Pick<CronJob, 'id' | 'profile'>): string =>
  JSON.stringify([job.profile ?? '', job.id])

// Cron *jobs* (not run sessions) power the sidebar "Cron jobs" section. Listing
// the job — schedule, state, live next-run countdown — makes the job the
// first-class entity; its runs (sessions) resolve under it in the cron detail.
export const $cronJobs = atom<CronJob[]>([])
export const $cronJobErrors = atom<ProfileReadError[]>([])

export interface CronJobsRequest {
  generation: number
  scope: string
}

export interface CronJobsScopeToken {
  generation: number
  scope: string
}

let cronJobsRequestGeneration = 0
let cronJobsRequestScope = ''
let cronJobsScopeGeneration = 0

function activateCronJobsScope(scope: string): void {
  if (scope === cronJobsRequestScope) {
    return
  }

  cronJobsRequestScope = scope
  cronJobsRequestGeneration += 1
  cronJobsScopeGeneration += 1
}

export function beginCronJobsRequest(scope: string): CronJobsRequest {
  activateCronJobsScope(scope)
  cronJobsRequestGeneration += 1

  return { generation: cronJobsRequestGeneration, scope }
}

export function beginCronJobsAction(scope: string): CronJobsScopeToken {
  activateCronJobsScope(scope)

  return { generation: cronJobsScopeGeneration, scope }
}

export function isCronJobsScopeCurrent(token: CronJobsScopeToken): boolean {
  return token.scope === cronJobsRequestScope && token.generation === cronJobsScopeGeneration
}

export function isCronJobsRequestCurrent(request: CronJobsRequest): boolean {
  return request.scope === cronJobsRequestScope && request.generation === cronJobsRequestGeneration
}

export function invalidateCronJobsRequests(): void {
  cronJobsRequestGeneration += 1
  cronJobsScopeGeneration += 1
}

export function commitCronJobsRequest(request: CronJobsRequest, jobs: CronJobList): boolean {
  if (!isCronJobsRequestCurrent(request)) {
    return false
  }

  // Consume the token so neither a duplicate completion nor any older request
  // can publish after this authoritative snapshot.
  cronJobsRequestGeneration += 1
  const errors = jobs.errors ?? []
  const failed = new Set(
    errors.filter(error => !('code' in error) || error.code !== 'support-profile-refused').map(error => error.profile)
  )
  const incoming = new Set(jobs.map(cronJobIdentity))
  $cronJobs.set([
    ...jobs,
    ...$cronJobs.get().filter(job => job.profile && failed.has(job.profile) && !incoming.has(cronJobIdentity(job)))
  ])
  $cronJobErrors.set(errors)

  return true
}

export function failCronJobsRequest(request: CronJobsRequest, error: unknown): boolean {
  if (!isCronJobsRequestCurrent(request)) {
    return false
  }

  cronJobsRequestGeneration += 1
  const message = stripIpcErrorPrefix(error instanceof Error ? error.message : String(error))
  const status = Number(/^\s*(\d{3}):/.exec(message)?.[1])
  const unauthorized =
    status === 401 || status === 403 || /^profile \S+ is not authorized for this session$/.test(message)

  if (unauthorized) {
    $cronJobs.set([])
    $cronJobErrors.set([])
  }

  return true
}

export const setCronJobs = (jobs: CronJob[]) => {
  cronJobsRequestGeneration += 1
  $cronJobs.set(jobs)
  $cronJobErrors.set([])
}

// In-place edit so the cron overlay's mutations (create/edit/delete/pause/…)
// land in the same atom the sidebar renders — no stale list until the next poll.
export const updateCronJobs = (fn: (jobs: CronJob[]) => CronJob[]) => {
  cronJobsRequestGeneration += 1
  $cronJobs.set(fn($cronJobs.get()))
}

// One-shot focus target: clicking "Manage" on a job sets this, then opens the
// cron overlay, which reads it once to select + scroll to that job. Cleared
// after consumption so re-opening cron normally doesn't re-focus a stale job.
export const $cronFocusJobId = atom<null | string>(null)
export const setCronFocusJobId = (id: null | string) => $cronFocusJobId.set(id)

// Shell-owned one-shot intent for stores without router context. Do not set a
// focus id here: the cron overlay's first fetch may not have loaded that row.
export const $cronReviewRequest = atom(0)
export const requestCronReview = () => $cronReviewRequest.set($cronReviewRequest.get() + 1)
