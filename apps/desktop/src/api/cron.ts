import type {
  AutomationBlueprint,
  CronDeliveryTarget,
  CronJob,
  CronJobCreatePayload,
  CronJobList,
  CronJobUpdates,
  ProfileReadError,
  SessionInfo
} from '@/types/hermes'

import { connectionScoped, hermesApi, profileScoped, scopeProfiled, STARTUP_REQUEST_TIMEOUT_MS } from './client'

// The cron trigger endpoint intentionally waits for the whole job so its
// response reflects the persisted execution result. Agent jobs can run far
// longer than the Electron fetch default; keep this override local to the one
// synchronous long-operation endpoint rather than weakening all API timeouts.
const CRON_TRIGGER_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000

function cronProfileSuffix(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : ''
}

// The cron page lists the sidebar's scope, so an unnamed request belongs to
// that scope too — under a support lease, the picked sibling rather than the
// anchor (#347). A named profile is an explicit pin, as before.
function cronScoped(profile?: string): { priority?: 'foreground'; profile?: string } {
  return profile === undefined ? scopeProfiled() : profileScoped(profile)
}

// Cron jobs are stored per-profile (<HERMES_HOME>/cron/jobs.json), and the
// backend's list endpoint defaults to 'all'. Pass a concrete profile key to
// list just that profile's jobs, or 'all' for the unified cross-profile view.
// Omitting the arg keeps the legacy 'all' default for non-profile callers.
// cronScoped() still rides along for backend-process routing.
export async function getCronJobs(profile?: string): Promise<CronJobList> {
  const result = await hermesApi<CronJob[] | { errors?: ProfileReadError[]; jobs: CronJob[] }>({
    ...cronScoped(),
    ...connectionScoped(),
    path: `/api/cron/jobs${cronProfileSuffix(profile)}`,
    timeoutMs: STARTUP_REQUEST_TIMEOUT_MS
  })

  return Array.isArray(result) ? result : Object.assign(result.jobs, { errors: result.errors ?? [] })
}

export function getCronJob(jobId: string): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronScoped(),
    ...connectionScoped(),
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}`
  })
}

export async function getCronJobRuns(jobId: string, limit = 20, profile?: string): Promise<SessionInfo[]> {
  const { runs } = await hermesApi<{ runs: SessionInfo[] }>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`
  })

  return runs ?? []
}

// The single source of truth for cron delivery targets (local + configured
// gateways). Both the manual cron editor and the blueprint dialog use this so
// they never offer a platform that isn't connected. Mirrors the dashboard.
export async function getCronDeliveryTargets(): Promise<CronDeliveryTarget[]> {
  const { targets } = await hermesApi<{ targets: CronDeliveryTarget[] }>({
    ...cronScoped(),
    ...connectionScoped(),
    path: '/api/cron/delivery-targets'
  })

  return targets ?? []
}

export function createCronJob(body: CronJobCreatePayload, profile?: string): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/jobs${cronProfileSuffix(profile)}`,
    method: 'POST',
    body
  })
}

export function updateCronJob(jobId: string, updates: CronJobUpdates, profile?: string): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}${cronProfileSuffix(profile)}`,
    method: 'PUT',
    body: { updates }
  })
}

export function pauseCronJob(jobId: string, profile?: string): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}/pause${cronProfileSuffix(profile)}`,
    method: 'POST'
  })
}

export function resumeCronJob(jobId: string, profile?: string): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}/resume${cronProfileSuffix(profile)}`,
    method: 'POST'
  })
}

export function triggerCronJob(jobId: string, profile?: string): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}/trigger${cronProfileSuffix(profile)}`,
    method: 'POST',
    timeoutMs: CRON_TRIGGER_REQUEST_TIMEOUT_MS
  })
}

export function deleteCronJob(jobId: string, profile?: string): Promise<{ ok: boolean }> {
  return hermesApi<{ ok: boolean }>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}${cronProfileSuffix(profile)}`,
    method: 'DELETE'
  })
}

// Automation Blueprints — parameterized cron templates the backend serves from
// cron/blueprint_catalog.py. getAutomationBlueprints returns the gallery
// (deliver options already rewritten to this machine's configured gateways);
// instantiateAutomationBlueprint fills the slots and creates a real cron job via
// the same create_job path as createCronJob.
//
// Profile-scoping is intentionally asymmetric: the GET catalog is global (the
// list endpoint takes no profile — only deliver options are rewritten from the
// configured gateways), so it carries only the cronScoped() header for
// routing. instantiate creates a real per-profile job, so it names the target
// profile explicitly via ?profile=. This mirrors the dashboard's api.ts.
export function getAutomationBlueprints(): Promise<{ blueprints: AutomationBlueprint[] }> {
  return hermesApi<{ blueprints: AutomationBlueprint[] }>({
    ...cronScoped(),
    ...connectionScoped(),
    path: '/api/cron/blueprints',
    timeoutMs: STARTUP_REQUEST_TIMEOUT_MS
  })
}

export function instantiateAutomationBlueprint(
  body: { blueprint: string; values: Record<string, string> },
  profile: string
): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronScoped(profile),
    ...connectionScoped(),
    path: `/api/cron/blueprints/instantiate?profile=${encodeURIComponent(profile)}`,
    method: 'POST',
    body
  })
}
