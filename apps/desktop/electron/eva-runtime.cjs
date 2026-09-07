const fs = require('node:fs')
const path = require('node:path')

const {
  EVA_MANAGED_POLICY,
  EvaBrokerError,
  assertEvaManagedApiRequestAllowed,
  brokerPost,
  buildEvaDesktopAuthUrl,
  evaDesktopCodeChallenge,
  expiresSoon,
  launchEvaHermesRuntime,
  makeAuthState,
  makeEvaDesktopCodeVerifier,
  normalizeDesktopSession,
  normalizeHermesEnrollment,
  normalizeSupportEnrollment,
  parseEvaDesktopAuthCallback,
  pollEvaDeviceCode,
  publicEvaEnrollmentStatus,
  revokeEvaDesktopSession
} = require('./eva-managed.cjs')
const { createEvaWsRelay, normalizeEvaWsEndpoint, normalizeEvaWsProfile } = require('./eva-ws-relay.cjs')

const RUNTIME_ENROLLMENT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 10_000, 20_000, 30_000])
// `missing_hermes_agent_binding` means the signed-in identity owns no agent of
// its own. An internal admin never has one, so every ordinary `runtime_launch`
// for that account is rejected by design and the app used to sit in it
// silently: 345 identical 403 lines in a single day, and no surface telling the
// operator that the only way forward is a delegated support target. It is a
// missing capability, not a transient failure, so the first rejection latches
// one persistent, actionable state. Recovery is an operator action — Retry,
// Switch support target, or a fresh sign-in — or a later successful
// `runtime_launch`, all of which clear the latch.
const MISSING_AGENT_BINDING_CODE = 'missing_hermes_agent_binding'
const MISSING_AGENT_BINDING_MESSAGE =
  'No personal agent for this account — use Switch support target to open a customer agent.'
const SUPPORT_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
// Mirrors the broker's own normalizers (internal-support.ts UUID_RE /
// PROFILE_ID_RE) so a target the renderer hands over is rejected here, before
// it becomes a broker round-trip.
const SUPPORT_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SUPPORT_PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,120}$/
// pending: created, claim not confirmed. active: the enrollment owns the lease
// and the handle is kept alongside it, so a credential expiry that erases the
// enrollment cannot erase the only id able to end the row. cleanup: no
// enrollment owns it and a remote end is still owed.
const SUPPORT_LEASE_PHASES = new Set(['pending', 'active', 'cleanup'])
// The absolute lease deadline when the server's `support_expires_at` is not
// known: the two-minute pending request plus the one-hour non-extending lease.
// Past it the handle cannot name anything still endable, so it is dropped on
// read rather than retried on every sign-in for the life of the install.
const SUPPORT_LEASE_MAX_LIFETIME_MS = (60 + 2) * 60 * 1_000
// A lease runs a full hour server-side but ending it needs a live desktop
// session, so a start on a credential about to expire is refused up front.
const SUPPORT_START_MIN_DESKTOP_LIFETIME_MS = 5 * 60 * 1_000
const SUPPORT_LABEL_MAX_LENGTH = 120
const SUPPORT_CLIENTS_MAX = 500
const SUPPORT_PROFILES_MAX = 200
const SUPPORT_SIGN_IN_REQUIRED_MESSAGE = 'Sign in to Electric Sheep again to choose a support target.'

function boundedSupportLabel(value) {
  const label = Array.from(String(value ?? ''))
    .map(character => {
      const codePoint = character.codePointAt(0)
      return codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return label ? label.slice(0, SUPPORT_LABEL_MAX_LENGTH) : null
}

function normalizeSupportUuid(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return SUPPORT_UUID_RE.test(normalized) ? normalized : null
}

// The lease handle the app persists next to the enrollment: written BEFORE the
// claim so a crash or a failed claim still leaves something that can end the
// server-side row, kept through the enrollment's lifetime, and kept after a
// failed remote end so the next sign-in, start or End retries it. Dropped only
// on the broker's word or past the absolute lease deadline. Never carries a
// credential.
function normalizeSupportLease(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const supportSessionId = String(raw.support_session_id ?? '').trim()
  if (!SUPPORT_REQUEST_ID_RE.test(supportSessionId)) return null
  const recordedAt = Date.parse(String(raw.recorded_at || ''))
  if (!supportSessionId || !SUPPORT_LEASE_PHASES.has(raw.phase) || !Number.isFinite(recordedAt)) return null
  const supportExpiresAt = Date.parse(String(raw.support_expires_at || ''))
  const deadline = Number.isFinite(supportExpiresAt) ? supportExpiresAt : recordedAt + SUPPORT_LEASE_MAX_LIFETIME_MS
  if (deadline <= now) return null
  const requestId = String(raw.request_id || '')
  const actorEmail = typeof raw.actor_email === 'string' ? raw.actor_email.trim().slice(0, 320) : ''
  return {
    supportSessionId,
    requestId: SUPPORT_REQUEST_ID_RE.test(requestId) ? requestId : null,
    targetLabel: boundedSupportLabel(raw.target_label),
    phase: raw.phase,
    recordedAt: new Date(recordedAt).toISOString(),
    supportExpiresAt: Number.isFinite(supportExpiresAt) ? new Date(supportExpiresAt).toISOString() : null,
    // The account the lease belongs to: only that actor's desktop session can
    // end it, so a different employee signing in on the same install neither
    // retries it (a guaranteed 403) nor is blocked or shown a banner by it.
    actorEmail: actorEmail || null
  }
}

function serializeSupportLease(lease) {
  return {
    support_session_id: lease.supportSessionId,
    ...(lease.requestId ? { request_id: lease.requestId } : {}),
    ...(lease.targetLabel ? { target_label: lease.targetLabel } : {}),
    phase: lease.phase,
    recorded_at: lease.recordedAt,
    ...(lease.supportExpiresAt ? { support_expires_at: lease.supportExpiresAt } : {}),
    ...(lease.actorEmail ? { actor_email: lease.actorEmail } : {})
  }
}

// A handle with no recorded actor (written before the field existed) is
// treated as the current account's, exactly as before the field.
function supportLeaseOwnedBy(lease, desktop) {
  if (!lease?.actorEmail || !desktop?.email) return true
  return lease.actorEmail.toLowerCase() === desktop.email.toLowerCase()
}

// An `active` handle whose enrollment is gone — desktop credential expired or
// unreadable, enrollment cleared on a 401/403 — names a lease that is still
// owed a remote end. Derived on every read so no clearing path can miss it.
function reconcileSupportLease(lease, delegatedSupport) {
  if (!lease || lease.phase !== 'active' || delegatedSupport?.supportSessionId === lease.supportSessionId) return lease
  return { ...lease, phase: 'cleanup' }
}

// Directory rows are broker-authored: keep only the fields the picker renders,
// bounded, and only rows that can actually be started (assignment allowed, a VM
// and ≥1 profile), exactly as the dashboard picker filters them. A row the
// broker marks unassignable must never reach the operator's list. The caps
// count rows KEPT, so unusable rows cannot crowd startable ones out of the list.
function normalizeSupportClients(rows) {
  const clients = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (clients.length >= SUPPORT_CLIENTS_MAX) break
    // `!== false` and not `=== true`: a broker that predates the field still
    // lists, exactly like the dashboard's `assignment_allowed !== false`.
    if (row?.assignment_allowed === false) continue
    const customerAccountId = normalizeSupportUuid(row?.customer_account_id)
    const customerVmId = normalizeSupportUuid(row?.customer_vm_id)
    if (!customerAccountId || !customerVmId) continue
    const profiles = []
    for (const profile of Array.isArray(row.profiles) ? row.profiles : []) {
      if (profiles.length >= SUPPORT_PROFILES_MAX) break
      const profileId = String(profile?.profile_id ?? '').trim()
      if (!SUPPORT_PROFILE_ID_RE.test(profileId)) continue
      profiles.push({ profile_id: profileId, display_name: boundedSupportLabel(profile.display_name) ?? profileId })
    }
    if (!profiles.length) continue
    clients.push({
      customer_account_id: customerAccountId,
      customer_vm_id: customerVmId,
      display_name: boundedSupportLabel(row.display_name) ?? customerAccountId,
      profiles
    })
  }
  return clients
}

// The renderer's choice, validated into the exact body the dashboard picker
// sends on `create_internal_support_request`. `acknowledged` is a required
// literal true: the server refuses anything else and the app never asserts
// consent on the operator's behalf.
function normalizeSupportTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EvaBrokerError('evaOS Agent received an invalid support target.', 400, 'invalid-support-target')
  }
  const customerAccountId = normalizeSupportUuid(input.customer_account_id)
  const customerVmId = normalizeSupportUuid(input.customer_vm_id)
  const allAgents = input.profile_scope === 'customer'
  const rawProfileId = String(input.profile_id ?? '').trim()
  const profileId = !allAgents && SUPPORT_PROFILE_ID_RE.test(rawProfileId) ? rawProfileId : null
  if (!customerAccountId || !customerVmId || (!allAgents && !profileId)) {
    throw new EvaBrokerError('evaOS Agent received an invalid support target.', 400, 'invalid-support-target')
  }
  if (input.acknowledged !== true) {
    throw new EvaBrokerError('Support acknowledgement is required.', 400, 'support-acknowledgement-required')
  }
  const customerLabel = boundedSupportLabel(input.customer_label) ?? customerAccountId
  const agentLabel = allAgents ? 'All authorized agents' : boundedSupportLabel(input.agent_label) ?? profileId
  return {
    body: {
      customer_account_id: customerAccountId,
      customer_vm_id: customerVmId,
      // Customer scope carries no profile at all, as the contract states it.
      ...(allAgents ? { profile_scope: 'customer' } : { profile_id: profileId }),
      acknowledged: true
    },
    label: boundedSupportLabel(`${customerLabel} / ${agentLabel}`)
  }
}

function normalizeSupportRequestCreated(payload) {
  const requestId = String(payload?.request_id ?? '').trim()
  const supportSessionId = String(payload?.support_session_id ?? '').trim()
  const requestExpiresAt = Date.parse(String(payload?.request_expires_at || ''))
  if (payload?.ok !== true || !SUPPORT_REQUEST_ID_RE.test(requestId) || !SUPPORT_REQUEST_ID_RE.test(supportSessionId) || !Number.isFinite(requestExpiresAt)) {
    throw new EvaBrokerError('Electric Sheep returned an invalid support request.', 502, 'invalid-support-request')
  }
  return { requestId, supportSessionId, requestExpiresAt: new Date(requestExpiresAt).toISOString() }
}

function createEvaManagedRuntime(options) {
  if (
    !options?.statePath ||
    typeof options.encryptSecret !== 'function' ||
    typeof options.decryptSecret !== 'function'
  ) {
    throw new TypeError('evaOS Agent managed runtime requires statePath and secret custody functions.')
  }

  const rememberLog = options.rememberLog ?? (() => undefined)
  const advanceBootProgress = options.advanceBootProgress ?? (async () => undefined)
  const updateBootProgress = options.updateBootProgress ?? (() => undefined)
  const resetConnection = options.resetConnection ?? (() => undefined)
  const resetRenderer = options.resetRenderer ?? (async () => undefined)
  const launchRuntime = options.launchRuntime ?? launchEvaHermesRuntime
  const makeCodeVerifier = options.makeCodeVerifier ?? makeEvaDesktopCodeVerifier
  const codeChallengeFor = options.codeChallengeFor ?? evaDesktopCodeChallenge
  const pollDeviceCode = options.pollDeviceCode ?? pollEvaDeviceCode
  const revokeDesktopSession = options.revokeDesktopSession ?? revokeEvaDesktopSession
  const postBroker = options.brokerPost ?? brokerPost
  const createWsRelay = options.createWsRelay ?? createEvaWsRelay
  const scheduleSupportExpiry = options.scheduleSupportExpiry ?? setTimeout
  const cancelSupportExpiry = options.cancelSupportExpiry ?? clearTimeout
  const ensureSignInCallbackReady = options.ensureSignInCallbackReady ?? (async () => undefined)
  const statePath = options.statePath
  const now = options.now ?? Date.now
  const loginTimeoutMs = options.loginTimeoutMs ?? EVA_MANAGED_POLICY.loginTimeoutMs

  let signInPromise = null
  let runtimeEnrollmentPromise = null
  let runtimeEnrollmentPromiseForced = false
  let runtimeEnrollmentFailure = null
  let missingAgentBinding = false
  let pendingAuth = null
  let authGeneration = 0
  let runtimeGeneration = 0
  let runtimeSessionGeneration = 0
  let wsRelay = null
  let supportRevalidated = false
  let supportExpiryTimer = null
  let supportExpiryTimestamp = null
  let supportEndError = null
  let signInFailure = null
  let rendererResetPending = false
  let rendererResetPromise = null
  const supportRequestControllers = new Set()
  let delegatedReadCache = null

  function emptyState(signedOut = false) {
    return {
      desktop: null,
      runtime: null,
      delegatedSupport: null,
      desktopCredentialUnreadable: false,
      signedOut
    }
  }

  function readState() {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } catch {
      return emptyState()
    }
    if (!parsed || parsed.schema_version !== EVA_MANAGED_POLICY.schemaVersion) return emptyState()

    let desktop = null
    const persistedDesktopToken = parsed.desktop?.token
    const desktopCredentialPresent =
      (typeof persistedDesktopToken === 'string' && persistedDesktopToken.length > 0) ||
      (persistedDesktopToken &&
        typeof persistedDesktopToken === 'object' &&
        typeof persistedDesktopToken.value === 'string' &&
        persistedDesktopToken.value.length > 0)
    let desktopCredentialUnreadable = false
    let decryptedDesktopToken = ''
    try {
      decryptedDesktopToken = options.decryptSecret(persistedDesktopToken)
      if (desktopCredentialPresent && !decryptedDesktopToken) {
        desktopCredentialUnreadable = true
      }
    } catch {
      desktopCredentialUnreadable = Boolean(desktopCredentialPresent)
    }
    if (!desktopCredentialUnreadable) {
      try {
        desktop = normalizeDesktopSession({
          desktop_session: decryptedDesktopToken,
          desktop_session_expires_at: parsed.desktop?.expires_at,
          email: parsed.desktop?.email
        })
      } catch {
        desktop = null
      }
    }

    let runtime = null
    if (desktop) {
      try {
        const persistedDisplayName = parsed.runtime?.agent_display_name
        if (typeof persistedDisplayName !== 'string' || !persistedDisplayName.trim()) {
          throw new Error('legacy enrollment has no assigned-agent display label')
        }
        runtime = normalizeHermesEnrollment({
          schema_version: EVA_MANAGED_POLICY.enrollmentSchemaVersion,
          runtime: parsed.runtime?.runtime,
          customer_id: parsed.runtime?.customer_id,
          remote_backend: {
            base_url: parsed.runtime?.base_url,
            session_token: options.decryptSecret(parsed.runtime?.token),
            expires_at: parsed.runtime?.expires_at,
            agent_id: parsed.runtime?.agent_id,
            agent_display_name: parsed.runtime?.agent_display_name
          }
        })
      } catch {
        runtime = null
      }
    }

    let delegatedSupport = null
    let delegatedSupportNeedsClear = Boolean(
      parsed.delegated_support?.enrollment && !desktop && !desktopCredentialUnreadable
    )
    if (desktop && parsed.delegated_support?.enrollment) {
      try {
        const serialized = options.decryptSecret(parsed.delegated_support.enrollment)
        delegatedSupport = normalizeSupportEnrollment(JSON.parse(serialized), { now: now() })
        if (expiresSoon(delegatedSupport.supportExpiresAt, 0, now())) {
          delegatedSupport = null
          delegatedSupportNeedsClear = true
        }
      } catch {
        delegatedSupport = null
        delegatedSupportNeedsClear = true
      }
    }
    return {
      desktop,
      runtime,
      delegatedSupport,
      delegatedSupportNeedsClear,
      desktopCredentialUnreadable,
      supportSignInPending: parsed.support_sign_in_pending === true,
      rendererCleanupPending: parsed.renderer_cleanup_pending === true,
      supportLease: reconcileSupportLease(normalizeSupportLease(parsed.support_lease, now()), delegatedSupport),
      signedOut: parsed.signed_out === true
    }
  }

  // The lease handle outlives every other field, including the credential it
  // was created under, so it is read straight from disk: a caller that does not
  // name `supportLease` (most writes) carries it through unchanged, and only an
  // explicit `null` clears it.
  function persistedSupportLease() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (!parsed || parsed.schema_version !== EVA_MANAGED_POLICY.schemaVersion) return null
      return normalizeSupportLease(parsed.support_lease, now())
    } catch {
      return null
    }
  }

  function atomicWrite(payload) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(path.dirname(statePath), 0o700)
    } catch {
      // The OS may own the parent directory; the state file remains 0600.
    }
    const tempPath = `${statePath}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.chmodSync(tempPath, 0o600)
    fs.renameSync(tempPath, statePath)
    fs.chmodSync(statePath, 0o600)
  }

  function writeState(state) {
    const supportLease = state?.supportLease === undefined ? persistedSupportLease() : state.supportLease
    if (!state?.desktop) {
      if (!state?.signedOut && !state?.rendererCleanupPending && !supportLease) {
        fs.rmSync(statePath, { force: true })
        return
      }
      atomicWrite({
        schema_version: EVA_MANAGED_POLICY.schemaVersion,
        signed_out: state?.signedOut === true,
        ...(state?.rendererCleanupPending ? { renderer_cleanup_pending: true } : {}),
        ...(supportLease ? { support_lease: serializeSupportLease(supportLease) } : {})
      })
      return
    }

    atomicWrite({
      schema_version: EVA_MANAGED_POLICY.schemaVersion,
      signed_out: false,
      ...(state.supportSignInPending ? { support_sign_in_pending: true } : {}),
      ...(state.rendererCleanupPending ? { renderer_cleanup_pending: true } : {}),
      ...(supportLease ? { support_lease: serializeSupportLease(supportLease) } : {}),
      desktop: {
        token: options.encryptSecret(state.desktop.token),
        expires_at: state.desktop.expiresAt,
        email: state.desktop.email
      },
      runtime: state.runtime
        ? {
            token: options.encryptSecret(state.runtime.token),
            expires_at: state.runtime.expiresAt,
            base_url: state.runtime.baseUrl,
            agent_id: state.runtime.agentId,
            agent_display_name: state.runtime.agentDisplayName ?? state.runtime.agentId,
            customer_id: state.runtime.customerId,
            runtime: state.runtime.runtime
          }
        : null,
      delegated_support: state.delegatedSupport
        ? {
            enrollment: options.encryptSecret(
              JSON.stringify({
                schema_version: state.delegatedSupport.schemaVersion,
                runtime: state.delegatedSupport.runtime,
                customer_id: state.delegatedSupport.customerId,
                remote_backend: {
                  base_url: state.delegatedSupport.baseUrl,
                  session_token: state.delegatedSupport.token,
                  expires_at: state.delegatedSupport.expiresAt,
                  agent_id: state.delegatedSupport.agentId,
                  allowed_profiles: state.delegatedSupport.allowedProfiles,
                  agent_display_name: state.delegatedSupport.agentDisplayName
                },
                session_kind: state.delegatedSupport.sessionKind,
                support_session_id: state.delegatedSupport.supportSessionId,
                assignment_version: state.delegatedSupport.assignmentVersion,
                admin_bypass: state.delegatedSupport.adminBypass,
                support_expires_at: state.delegatedSupport.supportExpiresAt,
                activated_at: state.delegatedSupport.supportActivatedAt,
                profile: state.delegatedSupport.profile,
                presentation: {
                  customer_label: state.delegatedSupport.supportCustomerLabel,
                  agent_label: state.delegatedSupport.supportAgentLabel
                }
              })
            )
          }
        : null
    })
  }

  function clearRendererCleanupPendingState(state) {
    if (!state?.rendererCleanupPending) return
    if (!state.desktopCredentialUnreadable) {
      writeState({ ...state, rendererCleanupPending: false })
      return
    }

    // `state.desktop` is intentionally null when secure storage cannot read
    // the persisted token. Rewrite only the raw tombstone so the encrypted
    // enrollment remains available for a later retry or explicit sign-out.
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (
      !persisted ||
      persisted.schema_version !== EVA_MANAGED_POLICY.schemaVersion ||
      persisted.renderer_cleanup_pending !== true
    ) {
      return
    }
    delete persisted.renderer_cleanup_pending
    atomicWrite(persisted)
  }

  // Rewrites only the lease handle; every other persisted field is re-read so
  // a concurrent enrollment write is never clobbered with a stale copy.
  function persistSupportLease(lease) {
    const latest = readState()
    if (latest.desktopCredentialUnreadable) {
      // Same tombstone discipline as the renderer-cleanup flag: never rewrite
      // an encrypted enrollment through a state whose token could not be read.
      let persisted
      try {
        persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      } catch {
        return
      }
      if (!persisted || persisted.schema_version !== EVA_MANAGED_POLICY.schemaVersion) return
      if (lease) persisted.support_lease = serializeSupportLease(lease)
      else delete persisted.support_lease
      atomicWrite(persisted)
      return
    }
    writeState({ ...latest, supportLease: lease })
  }

  function clearSupportExpiryTimer() {
    if (supportExpiryTimer !== null) {
      cancelSupportExpiry(supportExpiryTimer)
      supportExpiryTimer = null
    }
    supportExpiryTimestamp = null
  }

  function requestRendererReset() {
    rendererResetPending = true
    if (rendererResetPromise) return rendererResetPromise

    const task = Promise.resolve(resetRenderer())
      .then(performed => {
        rendererResetPending = performed === false
        if (!rendererResetPending) {
          const state = readState()
          clearRendererCleanupPendingState(state)
        }
        return !rendererResetPending
      })
      .catch(() => {
        rendererResetPending = true
        return false
      })
      .finally(() => {
        if (rendererResetPromise === task) rendererResetPromise = null
      })
    rendererResetPromise = task
    return task
  }

  async function flushPendingRendererReset() {
    if (!rendererResetPending) return false
    return requestRendererReset()
  }

  async function requireRendererIsolation() {
    if (!rendererResetPending) return
    if (await requestRendererReset()) return
    throw new EvaBrokerError(
      'evaOS Agent is still isolating the previous support session.',
      503,
      'support-renderer-reset-failed'
    )
  }

  function armSupportExpiryTimer(support) {
    const supportExpiresAt = Date.parse(String(support?.supportExpiresAt || ''))
    if (!Number.isFinite(supportExpiresAt)) {
      clearSupportExpiryTimer()
      return
    }
    if (supportExpiryTimer !== null && supportExpiryTimestamp === supportExpiresAt) return

    clearSupportExpiryTimer()
    supportExpiryTimestamp = supportExpiresAt
    supportExpiryTimer = scheduleSupportExpiry(() => {
      supportExpiryTimer = null
      supportExpiryTimestamp = null
      const state = readState()
      if (state.delegatedSupportNeedsClear || !state.delegatedSupport) {
        if (state.delegatedSupportNeedsClear) clearDelegatedSupportState(state)
        return
      }
      if (expiresSoon(state.delegatedSupport.supportExpiresAt, 0, now())) {
        clearDelegatedSupportState(state)
        return
      }
      armSupportExpiryTimer(state.delegatedSupport)
    }, Math.max(0, supportExpiresAt - now()))
    supportExpiryTimer?.unref?.()
  }

  function currentState() {
    let state = readState()
    if (state.rendererCleanupPending) rendererResetPending = true
    if (state.delegatedSupportNeedsClear) {
      clearDelegatedSupportState(state)
      state = { ...state, delegatedSupport: null, delegatedSupportNeedsClear: false }
    } else if (state.delegatedSupport) {
      armSupportExpiryTimer(state.delegatedSupport)
    } else {
      clearSupportExpiryTimer()
    }
    return state
  }

  // `leaseEnded` is set only by a confirmed remote end: every other clear (the
  // credential expired, a 401/403 on resume) keeps the lease id as a cleanup
  // handle, because losing the enrollment is not the same as ending the row.
  function clearDelegatedSupportState(
    state = currentState(),
    { resetRendererState = true, invalidateEnrollment = true, leaseEnded = false } = {}
  ) {
    delegatedReadCache = null
    supportRevalidated = false
    supportEndError = null
    clearSupportExpiryTimer()
    if (invalidateEnrollment) {
      runtimeGeneration += 1
      runtimeEnrollmentPromise = null
      runtimeEnrollmentPromiseForced = false
    }
    runtimeSessionGeneration += 1
    for (const controller of supportRequestControllers) controller.abort()
    supportRequestControllers.clear()
    if (resetRendererState) rendererResetPending = true
    writeState({
      desktop: state.desktop,
      runtime: state.runtime,
      delegatedSupport: null,
      rendererCleanupPending: resetRendererState,
      supportLease: leaseEnded ? survivingSupportLease(state) : cleanupSupportLease(state),
      signedOut: state.signedOut
    })
    resetConnection()
    wsRelay?.disconnectAll()
    if (resetRendererState) return requestRendererReset()
    return Promise.resolve(true)
  }

  function supportProfileFor(runtime, requestedProfile) {
    let requested = normalizeEvaWsProfile(requestedProfile)
    if (runtime?.sessionKind === 'delegated_support') {
      // Match the gateway's default alias, without overriding a real profile
      // named default when that profile is explicitly in the grant.
      if (requested === 'default' && !runtime.allowedProfiles.includes('default')) requested = null
      if (requested !== null && !runtime.allowedProfiles.includes(requested)) {
        throw new EvaBrokerError(
          'evaOS Agent rejected a profile outside the support assignment.',
          403,
          'support-profile-mismatch'
        )
      }
      return requested ?? runtime.profile ?? null
    }
    return requested
  }

  function supportSessionExpiredError() {
    return new EvaBrokerError('evaOS Agent support session expired.', 401, 'support-session-expired')
  }

  function startSupportRequestGuard(runtime) {
    if (runtime?.sessionKind !== 'delegated_support') return null
    const controller = new AbortController()
    const guard = {
      controller,
      generation: runtimeSessionGeneration,
      supportExpiresAt: runtime.supportExpiresAt,
      supportSessionId: runtime.supportSessionId
    }
    supportRequestControllers.add(controller)
    return guard
  }

  function finishSupportRequestGuard(guard) {
    if (guard) supportRequestControllers.delete(guard.controller)
  }

  function assertSupportRequestCurrent(guard) {
    if (!guard) return
    const state = readState()
    if (
      guard.controller.signal.aborted ||
      guard.generation !== runtimeSessionGeneration ||
      state.delegatedSupport?.supportSessionId !== guard.supportSessionId ||
      expiresSoon(guard.supportExpiresAt, 0, now())
    ) {
      throw supportSessionExpiredError()
    }
  }

  function normalizeSupportRequestError(error, guard) {
    if (!guard) return error
    if (guard?.controller.signal.aborted || guard?.generation !== runtimeSessionGeneration) {
      return supportSessionExpiredError()
    }
    return error
  }

  function getWsRelay() {
    if (!wsRelay) {
      wsRelay = createWsRelay({
        getGeneration: () => runtimeSessionGeneration,
        getUpstream: async () => {
          const runtime = await ensureRuntimeEnrollment()
          return {
            baseUrl: runtime.baseUrl,
            generation: runtimeSessionGeneration,
            token: runtime.token
          }
        },
        onAuthRejected: clearRuntimeEnrollment,
        onEvent: event => rememberLog(`[eva-managed] websocket relay ${event}`)
      })
    }
    return wsRelay
  }

  function clearRuntimeEnrollment() {
    const state = currentState()
    if (state.delegatedSupport) {
      // A rejected Hermes token is not authoritative proof that the support
      // assignment ended. Preserve the encrypted handle so the broker can
      // revalidate or end it, while severing every connection issued under the
      // rejected runtime credential.
      supportRevalidated = false
      runtimeGeneration += 1
      runtimeEnrollmentPromise = null
      runtimeEnrollmentPromiseForced = false
      runtimeSessionGeneration += 1
      for (const controller of supportRequestControllers) controller.abort()
      supportRequestControllers.clear()
      resetConnection()
      wsRelay?.disconnectAll()
      return
    }
    runtimeGeneration += 1
    runtimeEnrollmentPromise = null
    runtimeEnrollmentPromiseForced = false
    runtimeSessionGeneration += 1
    if (state.desktop) writeState({ desktop: state.desktop, runtime: null, delegatedSupport: null })
    resetConnection()
    wsRelay?.disconnectAll()
  }

  function resetRuntimeEnrollmentFailure() {
    if (missingAgentBinding) {
      missingAgentBinding = false
      rememberLog('[eva-managed] cleared the no-personal-agent state')
    }
    runtimeEnrollmentFailure = null
  }

  function isMissingAgentBindingError(error) {
    return statusCodeOf(error) === 403 && error?.code === MISSING_AGENT_BINDING_CODE
  }

  // Latches the terminal state and returns the actionable error to publish and
  // rethrow in place of the raw broker code. Only the transition is logged, so
  // the forensic log carries one line per state change and not one per poll.
  function latchMissingAgentBinding() {
    const published = new EvaBrokerError(MISSING_AGENT_BINDING_MESSAGE, 403, MISSING_AGENT_BINDING_CODE)
    if (!missingAgentBinding) {
      missingAgentBinding = true
      rememberLog(
        `[eva-managed] no personal agent for this account; switch support target required [code: ${MISSING_AGENT_BINDING_CODE}]`
      )
    }
    return published
  }

  // Publish the safe reason before the enrollment error is rethrown so the
  // renderer can dismiss CONNECTING and show its recovery actions.
  function publishEnrollmentFailure(error) {
    const message = enrollmentFailureMessage(error)
    try {
      updateBootProgress({
        error: message,
        message,
        phase: 'eva.enroll.error',
        progress: 100,
        running: false
      })
    } catch {
      // Progress publication must not replace the original enrollment
      // error or change the auth/routing result.
    }
  }

  function recordRuntimeEnrollmentFailure(error) {
    const attempts = (runtimeEnrollmentFailure?.attempts ?? 0) + 1
    const delay =
      RUNTIME_ENROLLMENT_RETRY_DELAYS_MS[Math.min(attempts - 1, RUNTIME_ENROLLMENT_RETRY_DELAYS_MS.length - 1)]
    runtimeEnrollmentFailure = {
      attempts,
      error,
      nextRetryAt: now() + delay
    }
  }

  function recordTerminalRuntimeEnrollmentFailure(error) {
    runtimeEnrollmentFailure = {
      attempts: (runtimeEnrollmentFailure?.attempts ?? 0) + 1,
      error,
      nextRetryAt: Number.POSITIVE_INFINITY
    }
  }

  function invalidateAuthWork() {
    delegatedReadCache = null
    authGeneration += 1
    runtimeGeneration += 1
    runtimeSessionGeneration += 1
    const pending = pendingAuth
    if (pending) {
      pendingAuth = null
      try {
        pending.controller?.abort()
      } catch {
        // The pending request already completed.
      }
      pending.authState = null
      pending.deviceCode = null
      pending.verifier = null
      pending.resolveDeviceCode = null
    }
    signInPromise = null
    runtimeEnrollmentPromise = null
    runtimeEnrollmentPromiseForced = false
    supportRevalidated = false
    resetRuntimeEnrollmentFailure()
    for (const controller of supportRequestControllers) controller.abort()
    supportRequestControllers.clear()
    resetConnection()
    wsRelay?.disconnectAll()
  }

  function assertGeneration(auth, runtime = null) {
    if (auth !== authGeneration || (runtime !== null && runtime !== runtimeGeneration)) {
      throw new EvaBrokerError('evaOS Agent ignored a stale sign-in response.', 409, 'stale-auth')
    }
  }

  async function beginSignIn(signInOptions = {}) {
    if (signInPromise) return signInPromise

    const supportLoginVersion = signInOptions.plainSession === true ? 2 : 1
    const generation = authGeneration
    const task = (async () => {
      let stage = 'browser-sign-in'
      let cleanupGeneration = null
      let authState = makeAuthState()
      let verifier = makeCodeVerifier()
      let deviceCode = null
      const codeChallenge = codeChallengeFor(verifier)
      const controller = new AbortController()
      let resolveDeviceCode
      let rejectDeviceCode
      const deviceCodePromise = new Promise((resolve, reject) => {
        resolveDeviceCode = resolve
        rejectDeviceCode = reject
      })
      // Browser launch may fail before we await the callback. Cancellation
      // still rejects the original promise, but never becomes unhandled.
      void deviceCodePromise.catch(() => undefined)
      const attempt = {
        authState,
        controller,
        deviceCode: null,
        generation,
        resolveDeviceCode,
        verifier
      }
      controller.signal.addEventListener(
        'abort',
        () => rejectDeviceCode(new EvaBrokerError('evaOS Agent sign-in was cancelled.', 409, 'stale-auth')),
        { once: true }
      )
      pendingAuth = attempt
      try {
        await advanceBootProgress('eva.sign-in', 'Complete evaOS Agent sign-in in your browser', 14)
        await options.openExternal(buildEvaDesktopAuthUrl(codeChallenge, authState, EVA_MANAGED_POLICY, { supportLoginVersion }))
        let callbackTimer
        try {
          callbackTimer = setTimeout(() => {
            rejectDeviceCode(new EvaBrokerError('evaOS Agent sign-in timed out.', 408, 'timeout'))
          }, loginTimeoutMs)
          callbackTimer.unref?.()
          deviceCode = await deviceCodePromise
        } finally {
          clearTimeout(callbackTimer)
        }
        stage = 'device-code-claim'
        const { supportRequestId, ...desktop } = await pollDeviceCode(deviceCode, verifier, { signal: controller.signal })
        controller.abort()
        assertGeneration(generation)
        attempt.supportPending = Boolean(supportRequestId)
        writeState({ desktop, runtime: null, delegatedSupport: null, supportSignInPending: Boolean(supportRequestId) })
        if (supportRequestId) {
          stage = 'support-claim'
          try {
            await claimSupportRequest(supportRequestId)
            assertGeneration(generation)
          } catch (error) {
            // No fallback to another workspace after an explicit customer
            // choice. Revoke only this just-created employee session and clear
            // its local view; a newer sign-in/sign-out retains state ownership.
            if (generation === authGeneration) {
              cleanupGeneration = generation + 1
              await signOut()
            }
            else await revokeDesktopSession(desktop.token).catch(() => false)
            throw error
          }
        }
        await advanceBootProgress('eva.authorized', 'Electric Sheep sign-in complete', 22)
        return desktop
      } catch (error) {
        // brokerPost already projects broker failures; never log a stack, URL,
        // payload or arbitrary exception from browser/transport integrations.
        const message = error instanceof EvaBrokerError
          ? error.message
          : 'evaOS Agent sign-in could not be completed.'
        rememberLog(`[eva-managed] ${stage} failed: ${message}`)
        if ((generation === authGeneration && pendingAuth === attempt) ||
          (cleanupGeneration === authGeneration && currentState().signedOut && !pendingAuth)) {
          signInFailure = message
        }
        throw error
      } finally {
        controller.abort()
        if (pendingAuth === attempt) pendingAuth = null
        attempt.authState = null
        attempt.deviceCode = null
        attempt.verifier = null
        attempt.resolveDeviceCode = null
        authState = null
        deviceCode = null
        verifier = null
      }
    })()

    signInPromise = task
    void task
      .finally(() => {
        if (signInPromise === task) signInPromise = null
      })
      .catch(() => undefined)
    return task
  }

  function requireSignIn() {
    resetRuntimeEnrollmentFailure()
    writeState(emptyState(true))
    updateBootProgress(
      {
        phase: 'eva.sign-in-required',
        message: signInFailure ?? 'Sign in to evaOS Agent from Settings.',
        progress: 8,
        running: false,
        error: signInFailure
      },
      { allowDecrease: true }
    )
    throw new EvaBrokerError('Sign in to evaOS Agent from Settings.', 401, 'sign-in-required')
  }

  async function ensureDesktopSession() {
    const state = currentState()
    if (state.desktop && !expiresSoon(state.desktop.expiresAt, 0)) return state.desktop
    if (state.desktopCredentialUnreadable) {
      throw new EvaBrokerError(
        'evaOS Agent could not read managed access from secure storage. Unlock secure storage and try again, or sign in again from Settings.',
        503,
        'managed-enrollment-unreadable'
      )
    }
    return requireSignIn()
  }

  function statusCodeOf(error) {
    const statusCode = Number(error?.statusCode)
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) return statusCode
    if (error?.isReauthRequired === true) return 401
    const match = /^\s*(\d{3})(?::|\b)/.exec(String(error?.message || ''))
    return match ? Number(match[1]) : null
  }

  function isStaleAuthError(error) {
    return error?.brokerRejected !== true && error?.code === 'stale-auth'
  }

  function isRetryableEnrollmentFailure(error) {
    const statusCode = statusCodeOf(error)
    return statusCode === null || statusCode === 408 || statusCode === 429 || statusCode >= 500
  }

  function enrollmentFailureMessage(error) {
    if (error instanceof EvaBrokerError && typeof error.message === 'string' && error.message.length <= 240) {
      return error.message
    }
    const statusCode = statusCodeOf(error)
    const code = String(error?.code || '').match(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/)?.[0]
    const diagnostic = code ? ` [code: ${code}]` : ''
    return `evaOS Agent enrollment was rejected (${statusCode ?? 'unknown'}).${diagnostic}`
  }

  function assertSupportRequestId(value) {
    const requestId = String(value || '').trim()
    if (!SUPPORT_REQUEST_ID_RE.test(requestId)) {
      throw new EvaBrokerError('evaOS Agent received an invalid support request.', 400, 'invalid-support-request')
    }
    return requestId
  }

  function assertSupportResumeMatches(previous, resumed) {
    if (
      resumed.supportSessionId !== previous.supportSessionId ||
      resumed.assignmentVersion !== previous.assignmentVersion ||
      resumed.adminBypass !== previous.adminBypass ||
      resumed.customerId !== previous.customerId ||
      resumed.agentId !== previous.agentId ||
      (previous.profile && resumed.profile !== previous.profile) ||
      [...resumed.allowedProfiles].sort().join('\n') !== [...previous.allowedProfiles].sort().join('\n') ||
      Date.parse(resumed.supportExpiresAt) > Date.parse(previous.supportExpiresAt)
    ) {
      throw new EvaBrokerError('evaOS Agent rejected a changed support assignment.', 403, 'support-assignment-mismatch')
    }
  }

  async function resumeDelegatedSupport(desktop, previous, auth, runtime) {
    const payload = await postBroker(
      {
        action: 'internal_support_session_resume',
        desktop_support_profiles_version: 1,
        support_session_id: previous.supportSessionId
      },
      { desktopSession: desktop.token }
    )
    const resumed = normalizeSupportEnrollment(payload, { now: now() })
    assertSupportResumeMatches(previous, resumed)
    assertGeneration(auth, runtime)
    writeState({ desktop, runtime: readState().runtime, delegatedSupport: resumed })
    supportRevalidated = true
    supportEndError = null
    armSupportExpiryTimer(resumed)
    runtimeSessionGeneration += 1
    resetConnection()
    wsRelay?.disconnectAll()
    resetRuntimeEnrollmentFailure()
    return resumed
  }

  async function claimSupportRequest(requestId) {
    await requireRendererIsolation()
    const normalizedRequestId = assertSupportRequestId(requestId)
    const desktop = await ensureDesktopSession()
    const auth = authGeneration
    const runtime = runtimeGeneration
    const state = currentState()
    if (state.delegatedSupport && !expiresSoon(state.delegatedSupport.supportExpiresAt, 0, now())) {
      throw new EvaBrokerError('evaOS Agent already has an active support session.', 409, 'support-session-active')
    }
    const payload = await postBroker(
      {
        action: 'claim_internal_support_request',
        desktop_support_profiles_version: 1,
        request_id: normalizedRequestId
      },
      { desktopSession: desktop.token }
    )
    const support = normalizeSupportEnrollment(payload, { now: now() })

    try {
      assertGeneration(auth, runtime)
      let latest = currentState()
      if (!latest.desktop || latest.desktop.token !== desktop.token || latest.desktop.email !== desktop.email) {
        throw new EvaBrokerError('evaOS Agent ignored a stale support response.', 409, 'stale-auth')
      }

      if (!(await requestRendererReset())) {
        throw new EvaBrokerError(
          'evaOS Agent could not isolate the delegated support session.',
          503,
          'support-renderer-reset-failed'
        )
      }
      assertGeneration(auth, runtime)
      latest = currentState()
      if (!latest.desktop || latest.desktop.token !== desktop.token || latest.desktop.email !== desktop.email) {
        throw new EvaBrokerError('evaOS Agent ignored a stale support response.', 409, 'stale-auth')
      }
      writeState({
        desktop: latest.desktop,
        runtime: latest.runtime,
        delegatedSupport: support,
        supportLease: activeSupportLease(support, latest.desktop)
      })
    } catch (error) {
      await requestDelegatedSupportEnd({ desktop, delegatedSupport: support }).catch(() => false)
      if (error instanceof EvaBrokerError) throw error
      throw new EvaBrokerError(
        'evaOS Agent could not isolate the delegated support session.',
        503,
        'support-renderer-reset-failed'
      )
    }

    supportRevalidated = true
    supportEndError = null
    armSupportExpiryTimer(support)
    runtimeGeneration += 1
    runtimeSessionGeneration += 1
    runtimeEnrollmentPromise = null
    runtimeEnrollmentPromiseForced = false
    resetRuntimeEnrollmentFailure()
    resetConnection()
    wsRelay?.disconnectAll()
    options.focusWindow?.()
    return publicEvaEnrollmentStatus(
      { desktop, runtime: currentState().runtime, delegatedSupport: support, supportEndError },
      now()
    )
  }

  async function endSupportSessionRemote(desktopToken, supportSessionId) {
    const result = await postBroker(
      {
        action: 'internal_support_session_end',
        support_session_id: supportSessionId
      },
      { desktopSession: desktopToken }
    )
    if (result?.ok !== true) {
      throw new EvaBrokerError('Electric Sheep could not end the support session.', 502, 'support-end-failed')
    }
    return true
  }

  async function requestDelegatedSupportEnd(state) {
    const support = state.delegatedSupport
    const desktop = state.desktop
    if (!support) return true
    if (!desktop || expiresSoon(desktop.expiresAt, 0, now())) {
      throw new EvaBrokerError('Electric Sheep desktop session expired.', 401, 'session-expired')
    }
    return endSupportSessionRemote(desktop.token, support.supportSessionId)
  }

  function desktopSessionLive(state) {
    return Boolean(state?.desktop && !expiresSoon(state.desktop.expiresAt, 0, now()))
  }

  // Only the broker saying the row no longer exists (404/410-class) settles a
  // handle. The same actor may end its own pending or active row from ANY live
  // desktop session, so a 403 on our own row proves neither termination nor
  // expiry — it is kept and retried; the absolute lease deadline bounds that.
  // A dead desktop session (401), a broker outage or a transport failure keep
  // it for the next attempt as before.
  function isDefinitiveSupportEndRejection(error) {
    if (error?.brokerRejected !== true) return false
    const statusCode = statusCodeOf(error)
    return statusCode === 404 || statusCode === 410
  }

  // Broker outcomes the picker renders as states rather than as a thrown IPC
  // error. 401 is deliberately "sign in again" AND "update required": until the
  // broker accepts the desktop session for these actions it answers 401 too,
  // and the operator's only move is the same in both cases.
  function supportFlowFailure(error) {
    const statusCode = statusCodeOf(error)
    const code = String(error?.code || '').match(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/)?.[0] ?? null
    if (statusCode === 401) {
      return { ok: false, reason: 'needs_sign_in', code, message: SUPPORT_SIGN_IN_REQUIRED_MESSAGE }
    }
    if (
      statusCode === 403 &&
      (code === 'delegated_support_forbidden' || code === 'delegated_support_denied' || code === 'internal_membership_required')
    ) {
      return { ok: false, reason: 'forbidden', code, message: 'This account is not authorized for delegated support.' }
    }
    if (statusCode === 409 && code === 'delegated_support_conflict') {
      return {
        ok: false,
        reason: 'conflict',
        code,
        message: 'Another support session for this account is still active. End it, then try again.'
      }
    }
    return { ok: false, reason: 'error', code, message: enrollmentFailureMessage(error) }
  }

  function supportLeaseFromEnrollment(support, desktop, phase = 'cleanup') {
    return {
      supportSessionId: support.supportSessionId,
      requestId: null,
      targetLabel: boundedSupportLabel(`${support.supportCustomerLabel ?? ''} / ${support.supportAgentLabel ?? ''}`),
      phase,
      recordedAt: new Date(now()).toISOString(),
      supportExpiresAt: support.supportExpiresAt,
      actorEmail: desktop?.email ?? null
    }
  }

  // The handle a successful claim leaves next to the enrollment. A stranded
  // handle for a DIFFERENT row (a browser-flow claim over an unfinished
  // cleanup) is kept instead: it is that row's only remaining id, while this
  // lease still has its enrollment.
  function activeSupportLease(support, desktop) {
    const existing = persistedSupportLease()
    if (existing && existing.supportSessionId !== support.supportSessionId) return existing
    return {
      ...(existing ?? supportLeaseFromEnrollment(support, desktop)),
      phase: 'active',
      supportExpiresAt: support.supportExpiresAt,
      actorEmail: existing?.actorEmail ?? desktop?.email ?? null
    }
  }

  // The handle a cleared enrollment leaves behind: a remote end is still owed
  // unless the broker confirmed one. Prefers the persisted handle (it carries
  // the request id and label) and keeps a stranded handle for a different row.
  function cleanupSupportLease(state) {
    const support = state.delegatedSupport
    const lease = state.supportLease
    if (lease && (!support || lease.supportSessionId !== support.supportSessionId)) {
      return lease.phase === 'cleanup' ? lease : { ...lease, phase: 'cleanup' }
    }
    if (!support) return null
    return {
      ...(lease ?? supportLeaseFromEnrollment(support, state.desktop)),
      phase: 'cleanup',
      supportExpiresAt: lease?.supportExpiresAt ?? support.supportExpiresAt
    }
  }

  // After a CONFIRMED end of the enrollment's own row, a handle naming a
  // different row (a browser-flow claim over an unfinished cleanup) is still
  // owed its end and stays; only the ended row's handle goes.
  function survivingSupportLease(state) {
    const lease = state.supportLease
    if (!lease || lease.supportSessionId === state.delegatedSupport?.supportSessionId) return null
    return lease.phase === 'cleanup' ? lease : { ...lease, phase: 'cleanup' }
  }

  // Rewrites the handle only while it still names `lease`: a superseded start's
  // late end, or a stale claim's release, must never clear or rewrite a handle
  // a newer start has since persisted for a different row.
  function settleSupportLease(lease, next) {
    if (persistedSupportLease()?.supportSessionId !== lease.supportSessionId) return
    persistSupportLease(next)
  }

  let supportLeaseCleanupPromise = null

  // Ends a lease the app still holds a handle for but no enrollment: a claim
  // that never completed, a remote end that failed at sign-out, or an
  // enrollment a credential expiry erased. Runs at boot, after each sign-in,
  // before each start and from End, and only ever removes the handle once the
  // broker has settled the row one way or the other.
  function retrySupportLeaseCleanup(state = readState()) {
    if (supportLeaseCleanupPromise) return supportLeaseCleanupPromise
    const lease = state.supportLease
    if (!lease) return Promise.resolve(true)
    if (state.delegatedSupport?.supportSessionId === lease.supportSessionId) {
      // The claim landed; the enrollment owns the lease and the handle stays
      // beside it until a confirmed end.
      if (lease.phase !== 'active') persistSupportLease(activeSupportLease(state.delegatedSupport, state.desktop))
      return Promise.resolve(true)
    }
    if (!desktopSessionLive(state)) return Promise.resolve(false)
    if (!supportLeaseOwnedBy(lease, state.desktop)) {
      // Another employee's lease on this install: this session cannot end it
      // (a guaranteed 403), so it is left for its owner's next sign-in and
      // does not stand in this account's way.
      rememberLog('[eva-support] stranded support lease belongs to another account; left for its owner')
      return Promise.resolve(true)
    }
    const task = (async () => {
      try {
        await endSupportSessionRemote(state.desktop.token, lease.supportSessionId)
        settleSupportLease(lease, null)
        supportEndError = null
        rememberLog('[eva-support] stranded support lease ended')
        return true
      } catch (error) {
        if (isDefinitiveSupportEndRejection(error)) {
          settleSupportLease(lease, null)
          supportEndError = null
          rememberLog(`[eva-support] stranded support lease dropped: ${supportFlowFailure(error).code ?? 'broker-rejected'}`)
          return true
        }
        if (lease.phase !== 'cleanup') settleSupportLease(lease, { ...lease, phase: 'cleanup' })
        rememberLog('[eva-support] stranded support lease end failed; retry pending')
        return false
      }
    })().finally(() => {
      supportLeaseCleanupPromise = null
    })
    supportLeaseCleanupPromise = task
    return task
  }

  async function listSupportTargets() {
    const state = currentState()
    if (!desktopSessionLive(state)) {
      return supportFlowFailure(new EvaBrokerError(SUPPORT_SIGN_IN_REQUIRED_MESSAGE, 401, 'sign-in-required'))
    }
    void retrySupportLeaseCleanup(state).catch(() => false)
    let payload
    try {
      payload = await postBroker(
        { action: 'list_internal_support_clients', directory_only: true },
        { desktopSession: state.desktop.token }
      )
    } catch (error) {
      return supportFlowFailure(error)
    }
    if (payload?.ok !== true || !Array.isArray(payload.clients)) {
      return { ok: false, reason: 'error', code: 'invalid-support-directory', message: 'Electric Sheep returned an invalid customer directory.' }
    }
    return { ok: true, is_admin: payload.is_admin === true, clients: normalizeSupportClients(payload.clients) }
  }

  // create → persist handle → claim → launch. The handle is on disk before the
  // claim so nothing after (b) can strand the server-side row without a way to
  // end it; a failure after create ends the row with that handle, and a failed
  // end keeps the handle for `retrySupportLeaseCleanup`.
  async function startDelegatedSupport(input) {
    let target
    try {
      target = normalizeSupportTarget(input)
    } catch (error) {
      return supportFlowFailure(error)
    }
    let state = currentState()
    if (!desktopSessionLive(state)) {
      return supportFlowFailure(new EvaBrokerError(SUPPORT_SIGN_IN_REQUIRED_MESSAGE, 401, 'sign-in-required'))
    }
    if (expiresSoon(state.desktop.expiresAt, SUPPORT_START_MIN_DESKTOP_LIFETIME_MS, now())) {
      // The hour-long lease would outlive this credential, and ending it needs
      // a live one: a plain sign-in first is the cheap fix, so it is typed as
      // the same `needs_sign_in` the picker already routes to that sign-in.
      return supportFlowFailure(new EvaBrokerError(SUPPORT_SIGN_IN_REQUIRED_MESSAGE, 401, 'desktop-session-expiring'))
    }
    const auth = authGeneration
    if (state.delegatedSupport) {
      // The same broker end path as the End control: an abandoned 1 h lease is
      // exactly what makes the next create fail `delegated_support_conflict`.
      const ended = await endDelegatedSupport()
      if (ended?.ok !== true) {
        return {
          ok: false,
          reason: 'error',
          code: 'support-end-failed',
          message: 'End the current support session before switching support target.'
        }
      }
    }
    // A stranded handle is the ONLY way to end that older lease. Creating now
    // would overwrite it below and leave the earlier row live until the server
    // expires it — the exact loss this persistence exists to prevent.
    const cleaned = await retrySupportLeaseCleanup(currentState()).catch(() => false)
    if (cleaned !== true) {
      return {
        ok: false,
        reason: 'cleanup_pending',
        code: 'support-cleanup-pending',
        message: 'A previous support session could not be ended yet. End it, then try again.'
      }
    }
    state = currentState()
    if (auth !== authGeneration || !desktopSessionLive(state)) {
      return supportFlowFailure(new EvaBrokerError(SUPPORT_SIGN_IN_REQUIRED_MESSAGE, 401, 'sign-in-required'))
    }
    const desktop = state.desktop
    let created
    try {
      created = normalizeSupportRequestCreated(
        await postBroker({ action: 'create_internal_support_request', ...target.body }, { desktopSession: desktop.token })
      )
    } catch (error) {
      return supportFlowFailure(error)
    }
    const lease = {
      supportSessionId: created.supportSessionId,
      requestId: created.requestId,
      targetLabel: target.label,
      phase: 'pending',
      recordedAt: new Date(now()).toISOString(),
      supportExpiresAt: null,
      actorEmail: desktop.email ?? null
    }
    persistSupportLease(lease)
    // A sign-out and sign-in can land while the create is in flight. The claim
    // would then activate, on the NEW session, a target chosen under the old
    // one — support access the operator has since walked away from. The handle
    // is already on disk, so end the row instead of claiming it.
    if (auth !== authGeneration || !desktopSessionLive(currentState())) {
      rememberLog('[eva-support] support request created under a superseded session; ending it')
      await releaseCreatedSupportLease(
        desktop.token,
        lease,
        '[eva-support] superseded support request end failed; retry pending'
      )
      return supportFlowFailure(new EvaBrokerError(SUPPORT_SIGN_IN_REQUIRED_MESSAGE, 401, 'sign-in-required'))
    }
    rememberLog('[eva-support] support request created; claiming from the app')
    try {
      // The claim moves the handle to `active` beside the enrollment; it stays
      // there until a confirmed end.
      const status = await claimSupportRequest(created.requestId)
      return { ok: true, status }
    } catch (error) {
      const failure = supportFlowFailure(error)
      rememberLog(`[eva-support] in-app claim failed: ${failure.code ?? 'support-claim-failed'}`)
      await releaseCreatedSupportLease(
        desktop.token,
        lease,
        '[eva-support] support request end failed after a failed claim; retry pending'
      )
      return failure
    }
  }

  // End a row this app just created. A definitive broker answer drops the
  // handle; anything else keeps it for `retrySupportLeaseCleanup`. Only the
  // handle that still names this row is touched (see `settleSupportLease`).
  async function releaseCreatedSupportLease(desktopToken, lease, retryLog) {
    try {
      await endSupportSessionRemote(desktopToken, lease.supportSessionId)
      settleSupportLease(lease, null)
    } catch (endError) {
      if (isDefinitiveSupportEndRejection(endError)) settleSupportLease(lease, null)
      else {
        settleSupportLease(lease, { ...lease, phase: 'cleanup' })
        rememberLog(retryLog)
      }
    }
  }

  async function endDelegatedSupport() {
    const state = currentState()
    const support = state.delegatedSupport
    if (!support) {
      if (state.supportLease) {
        // A lease this app holds a handle for but no enrollment (a start that
        // failed after the server activated it, a sign-out or credential
        // expiry whose remote end never landed): End sends the end request
        // with the session in hand and reports honestly; the handle is
        // dropped only on the broker's word.
        if ((await retrySupportLeaseCleanup(state).catch(() => false)) !== true) {
          supportEndError = true
          return { ok: false }
        }
      }
      if (!state.rendererCleanupPending) return { ok: true }
      const isolated = await flushPendingRendererReset()
      if (!isolated) {
        supportEndError = true
        rememberLog('[eva-managed] support session ended but renderer isolation is still pending')
        return { ok: false }
      }
      supportEndError = null
      return { ok: true }
    }
    const auth = authGeneration

    try {
      await requestDelegatedSupportEnd(state)
    } catch {
      // Keep the encrypted handle and active relay so the operator can retry.
      // The absolute expiry timer remains the final safety boundary.
      supportEndError = true
      rememberLog('[eva-managed] support session end failed; retry required')
      return { ok: false }
    }
    const latest = currentState()
    if (
      auth !== authGeneration ||
      latest.delegatedSupport?.supportSessionId !== support.supportSessionId
    ) {
      // A newer sign-out, sign-in, or support session owns local state. The
      // stale remote completion must never restore or clear that newer state.
      return { ok: true }
    }
    const isolated = await clearDelegatedSupportState(state, { leaseEnded: true })
    if (!isolated) {
      supportEndError = true
      rememberLog('[eva-managed] support session ended but renderer isolation is still pending')
      return { ok: false }
    }
    return { ok: true }
  }

  async function ensureRuntimeEnrollment(input = {}) {
    await requireRendererIsolation()
    if (pendingAuth?.supportPending || currentState().supportSignInPending) {
      throw new EvaBrokerError('Customer support sign-in is incomplete. If interrupted, choose Sign In to clear it and start a fresh sign-in.', 409, 'support-sign-in-pending')
    }
    const force = input.force === true
    if (runtimeEnrollmentPromise) {
      if (!force || runtimeEnrollmentPromiseForced) return runtimeEnrollmentPromise
      runtimeGeneration += 1
      runtimeEnrollmentPromise = null
      runtimeEnrollmentPromiseForced = false
    } else if (force) {
      runtimeGeneration += 1
    }
    const auth = authGeneration
    const runtime = runtimeGeneration
    const current = currentState()
    const activeSupport = current.delegatedSupport && !expiresSoon(current.delegatedSupport.supportExpiresAt, 0, now())
    if (activeSupport && !force && supportRevalidated && !expiresSoon(current.delegatedSupport.expiresAt)) {
      return current.delegatedSupport
    }
    if (!force && !activeSupport && current.runtime && !expiresSoon(current.runtime.expiresAt)) return current.runtime
    if (!force && runtimeEnrollmentFailure && now() < runtimeEnrollmentFailure.nextRetryAt) {
      throw runtimeEnrollmentFailure.error
    }

    const task = (async () => {
      try {
        const desktop = await ensureDesktopSession()
        assertGeneration(auth, runtime)
        await advanceBootProgress('eva.enroll', 'Resolving your assigned evaOS agent', 26)
        let enrollment
        if (activeSupport) {
          try {
            return await resumeDelegatedSupport(desktop, current.delegatedSupport, auth, runtime)
          } catch (error) {
            const statusCode = statusCodeOf(error)
            if (statusCode !== 401 && statusCode !== 403 && error?.code !== 'support-assignment-mismatch') throw error
            // A revoked, expired, or changed assignment must not be used. The
            // ordinary managed enrollment remains intact, but the action that
            // arrived under delegated authority must fail rather than being
            // redirected to that ordinary identity.
            clearDelegatedSupportState(current, { resetRendererState: true, invalidateEnrollment: false })
            assertGeneration(auth, runtime)
            throw new EvaBrokerError('evaOS Agent support session expired.', 401, 'support-session-expired')
          }
        }
        try {
          enrollment = await launchRuntime(desktop.token)
        } catch (error) {
          if (!(error instanceof EvaBrokerError) || statusCodeOf(error) !== 401) throw error
          assertGeneration(auth, runtime)
          return requireSignIn()
        }
        assertGeneration(auth, runtime)
        writeState({ desktop, runtime: enrollment, delegatedSupport: null })
        supportRevalidated = false
        runtimeSessionGeneration += 1
        resetConnection()
        wsRelay?.disconnectAll()
        resetRuntimeEnrollmentFailure()
        return enrollment
      } catch (error) {
        const statusCode = statusCodeOf(error)
        if (statusCode !== 401 && !isStaleAuthError(error)) {
          assertGeneration(auth, runtime)
          if (isMissingAgentBindingError(error)) {
            // Not a readiness fault and not transient: this account owns no
            // agent. Latch the actionable terminal state on the first
            // rejection instead of re-throwing the raw broker code.
            const terminal = latchMissingAgentBinding()
            recordTerminalRuntimeEnrollmentFailure(terminal)
            publishEnrollmentFailure(terminal)
            throw terminal
          } else if (isRetryableEnrollmentFailure(error)) {
            recordRuntimeEnrollmentFailure(error)
          } else {
            // A deterministic broker/readiness rejection is terminal for this
            // boot attempt.
            recordTerminalRuntimeEnrollmentFailure(error)
            publishEnrollmentFailure(error)
          }
        }
        throw error
      }
    })()

    runtimeEnrollmentPromise = task
    runtimeEnrollmentPromiseForced = force
    void task
      .finally(() => {
        if (runtimeEnrollmentPromise === task) {
          runtimeEnrollmentPromise = null
          runtimeEnrollmentPromiseForced = false
        }
      })
      .catch(() => undefined)
    return task
  }

  async function resolveBackend(input = {}) {
    const requestedProfile = normalizeEvaWsProfile(input.profile)
    let profile = requestedProfile
    let runtime = await ensureRuntimeEnrollment({ force: input.force })
    const supportRequest = runtime.sessionKind === 'delegated_support'
    profile = supportProfileFor(runtime, profile)
    try {
      await options.waitForHermes(runtime.baseUrl, runtime.token)
    } catch (error) {
      if (statusCodeOf(error) !== 401) throw error
      clearRuntimeEnrollment()
      runtime = await ensureRuntimeEnrollment({ force: true })
      if (supportRequest && runtime.sessionKind !== 'delegated_support') {
        throw new EvaBrokerError('evaOS Agent support session expired.', 401, 'support-session-expired')
      }
      profile = supportProfileFor(runtime, requestedProfile)
      await options.waitForHermes(runtime.baseUrl, runtime.token)
    }
    const connection = {
      authMode: 'token',
      // Keep the renderer's connection key opaque while delegated support is
      // active. The canonical account id remains main-process-only.
      baseUrl:
        runtime.sessionKind === 'delegated_support'
          ? 'eva-managed://delegated-support'
          : `eva-managed://${runtime.customerId}`,
      mode: 'remote',
      source: 'electric-sheep',
      token: '',
      wsUrl: await getWsRelay().mintTicket({
        generation: runtimeSessionGeneration,
        path: '/api/ws',
        profile
      })
    }
    return profile ? { ...connection, profile } : connection
  }

  async function completeCallback(rawUrl) {
    const pending = pendingAuth
    if (!pending) {
      // A late deep link (browser finished after the 180 s window, or after a
      // sign-out) used to vanish without a trace; main.ts logs only throws.
      rememberLog('[eva-auth] callback ignored: no-pending')
      return false
    }
    const callback = parseEvaDesktopAuthCallback(rawUrl, pending.authState)
    if (pendingAuth !== pending)
      throw new EvaBrokerError('evaOS Agent ignored a stale sign-in callback.', 409, 'stale-auth')
    assertGeneration(pending.generation)
    if (pending.deviceCode && callback.deviceCode !== pending.deviceCode) {
      throw new EvaBrokerError('evaOS Agent sign-in device code did not match.', 400, 'device-code-mismatch')
    }
    pending.deviceCode = callback.deviceCode
    pending.resolveDeviceCode?.(callback.deviceCode)
    options.focusWindow?.()
    return true
  }

  async function signIn(signInOptions = {}) {
    const plainSession = signInOptions?.plainSession === true
    await requireRendererIsolation()
    if (currentState().delegatedSupport) {
      throw new EvaBrokerError('End the current support session before signing in again.', 409, 'support-session-active')
    }
    try {
      await ensureSignInCallbackReady()
    } catch (error) {
      const allowedCodes = new Set([
        'callback-handler-mismatch',
        'callback-handler-registration-failed',
        'callback-handler-repair-failed',
        'callback-handler-untrusted',
        'callback-noncanonical-install'
      ])
      const code = allowedCodes.has(error?.code) ? error.code : 'callback-handler-registration-failed'
      rememberLog(`[eva-managed] sign-in callback unavailable [code: ${code}]`)
      throw new EvaBrokerError(
        `evaOS Agent cannot receive sign-in links from this installation. [code: ${code}]`,
        503,
        code
      )
    }
    // Boot recovery exposes Sign In, not Settings sign-out. Consume the
    // interrupted enrollment through the existing cleanup before new login.
    if (currentState().supportSignInPending) await signOut()
    invalidateAuthWork()
    signInFailure = null
    writeState(emptyState())
    supportRevalidated = false
    const desktop = await beginSignIn({ plainSession })
    const auth = authGeneration
    void retrySupportLeaseCleanup(currentState()).catch(() => false)
    if (plainSession) {
      // The picker is the next step, so an account that owns no agent of its
      // own (the ordinary 403 for an internal admin) must not fail the sign-in;
      // the latch it sets keeps the banner and its Switch entry in place.
      try {
        await ensureRuntimeEnrollment({ force: true })
      } catch (error) {
        // Only a deferrable enrollment outcome is swallowed. A sign-out that
        // landed meanwhile (stale-auth) or a rejected desktop session (401)
        // leaves no session to report as signed in.
        if (isStaleAuthError(error) || statusCodeOf(error) === 401) throw error
        const code = String(error?.code || '').match(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/)?.[0]
        rememberLog(`[eva-managed] plain sign-in complete; enrollment deferred: ${code || 'enrollment-failed'}`)
      }
      assertGeneration(auth)
    } else {
      await ensureRuntimeEnrollment({ force: !currentState().delegatedSupport })
    }
    resetConnection()
    return publicEvaEnrollmentStatus({ desktop, runtime: currentState().runtime, delegatedSupport: currentState().delegatedSupport ?? null })
  }

  // The local wipe stays first so the renderer that reboots during the reset
  // can never resume the lease being ended, but the lease HANDLE moves into the
  // tombstone before either remote call: a remote end and a revoke that both
  // fail (offline, broker timeout) no longer lose the only id that can end the
  // row. The handle is cleared once the broker settles it or the revoke (which
  // ends bound leases server-side) succeeds, and retried on the next sign-in.
  async function signOut() {
    const state = currentState()
    invalidateAuthWork()
    const auth = authGeneration
    signInFailure = null
    clearSupportExpiryTimer()
    supportEndError = null
    rendererResetPending = true
    const lease = cleanupSupportLease(state)
    writeState({ ...emptyState(true), rendererCleanupPending: true, supportLease: lease })
    resetConnection()
    wsRelay?.disconnectAll()
    const rendererReset = requestRendererReset()
    let released = !lease
    if (lease && state.desktop) {
      released = await endSupportSessionRemote(state.desktop.token, lease.supportSessionId)
        .then(() => true)
        .catch(error => isDefinitiveSupportEndRejection(error))
      if (!released) rememberLog('[eva-managed] support session remote end failed after local sign-out; keeping the lease handle')
    }
    let revoked = false
    if (state.desktop) revoked = await revokeDesktopSession(state.desktop.token).catch(() => false)
    if (lease && (released || revoked) && auth === authGeneration && persistedSupportLease()?.supportSessionId === lease.supportSessionId) {
      persistSupportLease(null)
    }
    await rendererReset
    return { ok: true }
  }

  // The target picker is an app surface now (`listSupportTargets` +
  // `startDelegatedSupport` over the desktop session), so switching never signs
  // out: a live desktop session is already everything the picker needs, and an
  // active lease is ended by `startDelegatedSupport` only once a new target is
  // actually chosen. With no live session (or when the picker reports the
  // broker rejected the one it has) the browser is opened for a PLAIN sign-in
  // — one-click "Continue as", no page-side picker — and the caller opens the
  // picker once this resolves.
  async function switchSupportTarget(switchOptions = {}) {
    const signInAgain = switchOptions?.signInAgain === true
    if (!signInAgain && desktopSessionLive(currentState())) {
      return publicEvaEnrollmentStatus({ ...currentState(), supportEndError, missingAgentBinding })
    }
    // `signIn()` clears the no-personal-agent latch through
    // `invalidateAuthWork()`. That is right once the operator has landed on a
    // new target, but a cancelled browser or an expired device code must not
    // leave the app with no banner and no route back, so the recovery state is
    // restored when the handoff fails.
    const wasMissingAgentBinding = missingAgentBinding
    rememberLog('[eva-managed] switching support target; requesting a plain Electric Sheep sign-in')
    try {
      await signIn({ plainSession: true })
    } catch (error) {
      if (wasMissingAgentBinding && !missingAgentBinding) {
        missingAgentBinding = true
        rememberLog('[eva-managed] switch support target did not complete; keeping the no-personal-agent state')
      }
      throw error
    }
    return publicEvaEnrollmentStatus({ ...currentState(), supportEndError, missingAgentBinding })
  }

  async function refresh() {
    const previousState = currentState()
    const previousRuntime = previousState.delegatedSupport ?? previousState.runtime
    const runtime = await ensureRuntimeEnrollment({ force: true })
    const state = currentState()
    const status = publicEvaEnrollmentStatus({
      ...state,
      runtime: state.delegatedSupport ? state.runtime : runtime,
      supportEndError,
      missingAgentBinding
    })
    if (
      !previousRuntime ||
      previousRuntime.customerId !== runtime.customerId ||
      previousRuntime.agentId !== runtime.agentId
    ) {
      await resetRenderer()
    }
    return status
  }

  function supportProfileError() {
    return new EvaBrokerError(
      'evaOS Agent rejected a profile outside the support assignment.',
      403,
      'support-profile-mismatch'
    )
  }

  function bindSupportProfileValue(value, profile, runtime) {
    if (Array.isArray(value)) return value.map(entry => bindSupportProfileValue(entry, profile, runtime))
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (key !== 'profile') return [key, bindSupportProfileValue(entry, profile, runtime)]
        let requested
        try {
          requested = normalizeEvaWsProfile(entry)
        } catch {
          throw supportProfileError()
        }
        if (requested !== null && supportProfileFor(runtime, requested) !== profile) throw supportProfileError()
        return [key, profile]
      })
    )
  }

  function bindSupportRequest(runtime, request) {
    const profile = supportProfileFor(runtime, request?.profile)
    if (runtime?.sessionKind !== 'delegated_support') {
      const validated = assertEvaManagedApiRequestAllowed(profile ? { ...request, profile } : request)
      const parsed = new URL(validated.path, 'http://eva-managed.invalid')
      if (profile && validated.method === 'GET' && parsed.pathname === '/api/profiles/sessions' &&
        parsed.searchParams.get('profile') === 'all') {
        // Only delegated reads expand over a finite grant. Ordinary logins
        // retain the concrete selector previously supplied by the renderer.
        parsed.searchParams.set('profile', profile)
        return { policy: undefined, profile, request: { ...request, path: `${parsed.pathname}${parsed.search}` } }
      }
      return { policy: undefined, profile, request }
    }

    let path = request?.path
    if (!runtime.allowedProfiles.includes('default')) {
      const validated = assertEvaManagedApiRequestAllowed({ ...request, profile: request?.profile ?? profile }, { allowBroadProfileSelectors: false })
      const parsed = new URL(validated.path, 'http://eva-managed.invalid')
      if (parsed.searchParams.get('profile') === 'default') parsed.searchParams.set('profile', runtime.profile)
      path = `${parsed.pathname}${parsed.search}`
    }

    return {
      policy: { allowBroadProfileSelectors: false },
      profile,
      request: {
        ...request,
        path,
        body: bindSupportProfileValue(request?.body, profile, runtime)
      }
    }
  }

  async function readDelegatedProfile(request, retry, errors) {
    try {
      return await requestApi(request, retry)
    } catch (error) {
      const status = statusCodeOf(error)
      // A route outage is local to this profile. Authorization, policy and
      // lease failures still invalidate the aggregate rather than hiding them.
      if (status !== null && status < 500) throw error
      errors.push({ profile: request.profile, error: 'Profile temporarily unavailable.' })
      return null
    }
  }

  function bindSupportSession(row, profile) {
    if (row.profile != null && row.profile !== profile) throw supportProfileError()
    return { ...row, profile }
  }

  function supportReadCache(runtime) {
    if (delegatedReadCache?.sessionId !== runtime.supportSessionId) {
      delegatedReadCache = { sessionId: runtime.supportSessionId, profiles: new Map(), projects: new Map() }
    }
    return delegatedReadCache
  }

  async function requestDelegatedSessionList(runtime, request, profiles, retry) {
    const parsed = new URL(String(request.path), 'http://eva-managed.invalid')
    const limit = Number(parsed.searchParams.get('limit') ?? 20)
    const offset = Number(parsed.searchParams.get('offset') ?? 0)
    if (!Number.isInteger(limit) || limit < 0 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
      throw new EvaBrokerError('Invalid session page.', 400, 'managed-policy')
    }
    // Match the server's all-profile merge: fetch from zero on each profile,
    // then apply the requested page once to the globally ordered rows.
    parsed.searchParams.set('limit', String(Math.min(limit + offset, 500)))
    parsed.searchParams.set('offset', '0')
    const results = []
    const readErrors = []
    const guard = startSupportRequestGuard(runtime)
    try {
      for (const profile of profiles) {
        assertSupportRequestCurrent(guard)
        parsed.searchParams.set('profile', profile)
        const result = await readDelegatedProfile({ ...request, profile, path: `${parsed.pathname}?${parsed.searchParams}` }, retry, readErrors)
        assertSupportRequestCurrent(guard)
        results.push(result && { ...result, sessions: (result.sessions ?? []).map(row => bindSupportSession(row, profile)) })
      }
    } finally {
      finishSupportRequestGuard(guard)
    }
    const sortKey = parsed.searchParams.get('order') === 'created' ? 'started_at' : 'last_active'
    const rows = results.flatMap(result => result?.sessions ?? [])
      .sort((a, b) => (b[sortKey] || b.started_at || 0) - (a[sortKey] || a.started_at || 0))
    const sessions = [...rows.slice(offset, offset + limit), ...rows.slice(offset + limit).filter(row => row.pinned)]
    const profileTotals = Object.assign({}, ...results.map(result => result?.profile_totals ?? {}))
    const profilesTruncated = Object.assign({}, ...results.map(result => result?.profiles_truncated ?? {}))
    for (const [profile, total] of Object.entries(profileTotals)) {
      profilesTruncated[profile] = total > sessions.filter(row => row.profile === profile).length
    }
    return {
      sessions,
      total: results.reduce((sum, result) => sum + (result?.total ?? result?.sessions?.length ?? 0), 0),
      limit,
      offset,
      profile_totals: profileTotals,
      profiles_truncated: profilesTruncated,
      errors: [...readErrors, ...results.flatMap(result => result?.errors ?? [])]
    }
  }

  async function requestDelegatedProfiles(runtime, request, retry) {
    const profiles = []
    const errors = []
    const guard = startSupportRequestGuard(runtime)
    const cache = supportReadCache(runtime).profiles
    try {
      for (const profile of runtime.allowedProfiles) {
        assertSupportRequestCurrent(guard)
        const result = await readDelegatedProfile({ ...request, profile, path: `/api/profiles?profile=${encodeURIComponent(profile)}` }, retry, errors)
        assertSupportRequestCurrent(guard)
        const freshRows = result?.profiles ?? []
        for (const row of freshRows) {
          if (row.name !== profile) throw supportProfileError()
        }
        // The exact managed route suppresses metadata failures as an empty
        // successful response; it cannot delete a member of this live grant.
        if (result && !freshRows.length) errors.push({ profile, error: 'Profile temporarily unavailable.' })
        const rows = freshRows.length ? freshRows : cache.get(profile) ?? []
        if (freshRows.length) cache.set(profile, structuredClone(rows))
        profiles.push(...structuredClone(rows))
      }
      return { profiles, ...(errors.length ? { errors } : {}) }
    } finally {
      finishSupportRequestGuard(guard)
    }
  }

  async function requestDelegatedProjectTree(runtime, request, retry) {
    const parsed = new URL(String(request.path), 'http://eva-managed.invalid')
    const previewLimit = Number(parsed.searchParams.get('preview_limit') ?? 3)
    if (!Number.isInteger(previewLimit) || previewLimit < 0) {
      throw new EvaBrokerError('Invalid project preview.', 400, 'managed-policy')
    }
    const projects = new Map()
    const scopedIds = new Set()
    const errors = []
    const guard = startSupportRequestGuard(runtime)
    const cache = supportReadCache(runtime).projects
    // Match hermes_cli.web_routers.profiles._merge_profile_tree: folders/Home
    // merge, declared metadata wins over auto metadata, and counts sum.
    const recency = row => row.last_active || row.started_at || 0
    const mergeChildren = (existing, incoming, childKey) => {
      const byId = new Map((existing ?? []).map(row => [row.id, row]))
      for (const row of incoming ?? []) {
        const previous = byId.get(row.id)
        if (!previous) {
          byId.set(row.id, row)
          continue
        }
        previous[childKey] = childKey === 'sessions'
          ? [...(previous.sessions ?? []), ...(row.sessions ?? [])]
          : mergeChildren(previous[childKey], row[childKey], 'sessions')
        if ('sessionCount' in previous) previous.sessionCount = (previous.sessionCount || 0) + (row.sessionCount || 0)
      }
      return [...byId.values()]
    }
    try {
      for (const profile of runtime.allowedProfiles) {
        assertSupportRequestCurrent(guard)
        parsed.searchParams.set('profile', profile)
        const fresh = await readDelegatedProfile({ ...request, profile, path: `${parsed.pathname}?${parsed.searchParams}` }, retry, errors)
        assertSupportRequestCurrent(guard)
        // A failed read is not authoritative deletion. Keep this lease's last
        // matching view, while the errors array still reports the outage.
        const cached = cache.get(profile)
        const failed = !fresh || fresh.errors?.length
        const result = failed && cached?.previewLimit === previewLimit ? structuredClone(cached.result) : fresh
        for (const id of result?.scoped_session_ids ?? []) scopedIds.add(id)
        errors.push(...(fresh?.errors ?? []))
        for (const raw of result?.projects ?? []) {
          const bind = row => ({ ...bindSupportSession(row, profile), is_default_profile: profile === 'default' })
          let project = { ...raw, previewSessions: (raw.previewSessions ?? []).map(bind),
            repos: (raw.repos ?? []).map(repo => ({ ...repo,
              groups: (repo.groups ?? []).map(group => ({ ...group, sessions: (group.sessions ?? []).map(bind) })) })) }
          const key = project.path || project.id
          let existing = projects.get(key)
          if (!existing) {
            projects.set(key, project)
            continue
          }
          if (existing.isAuto && !project.isAuto) {
            ;[existing, project] = [project, existing]
            projects.set(key, existing)
          }
          existing.repos = mergeChildren(existing.repos, project.repos, 'groups')
          for (const field of ['sessionCount', 'totalTokens', 'totalCostUsd']) {
            existing[field] = (existing[field] || 0) + (project[field] || 0)
          }
          existing.lastActive = Math.max(existing.lastActive || 0, project.lastActive || 0)
          existing.previewSessions = [...existing.previewSessions, ...project.previewSessions]
            .sort((a, b) => recency(b) - recency(a)).slice(0, previewLimit)
        }
        if (fresh && !fresh.errors?.length) cache.set(profile, { previewLimit, result: structuredClone(fresh) })
      }
      return { projects: [...projects.values()].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0)),
        active_id: null, scoped_session_ids: [...scopedIds], errors }
    } finally {
      finishSupportRequestGuard(guard)
    }
  }

  async function requestDelegatedPullRequests(runtime, request, retry) {
    const errors = []
    let pullRequests = {}
    let scanned = null
    const guard = startSupportRequestGuard(runtime)
    try {
      for (const profile of runtime.allowedProfiles) {
        assertSupportRequestCurrent(guard)
        const result = await readDelegatedProfile({ ...request, profile,
          path: `/api/profiles/sessions/pull-requests?profile=${encodeURIComponent(profile)}` }, retry, errors)
        assertSupportRequestCurrent(guard)
        pullRequests = { ...pullRequests, ...(result?.pull_requests ?? {}) }
        errors.push(...(result?.errors ?? []))
        const completed = new Set(result?.scanned ?? [])
        scanned = scanned === null ? [...completed] : scanned.filter(id => completed.has(id))
      }
      // The consumer persists misses permanently. A partial read is not proof
      // that a requested session has no PR in another granted profile. Legacy
      // leaves can also suppress DB errors, so only positive results prove
      // completion; absent PRs must remain eligible for a later read.
      const confirmed = (scanned ?? []).filter(id => Object.hasOwn(pullRequests, id))
      return { pull_requests: pullRequests, scanned: errors.length ? [] : confirmed,
        ...(errors.length ? { errors } : {}) }
    } finally {
      finishSupportRequestGuard(guard)
    }
  }

  async function requestDelegatedSidebar(runtime, request, retry) {
    const parsed = new URL(String(request?.path || ''), 'http://eva-managed.invalid')
    const profile = runtime.profile
    supportProfileFor(runtime, request?.profile)
    const recentsProfile = parsed.searchParams.get('recents_profile') || 'all'
    const recentsProfiles = recentsProfile === 'all'
      ? runtime.allowedProfiles : [supportProfileFor(runtime, recentsProfile)]
    const slicePath = (limitKey, defaultLimit, extras = {}) => {
      const params = new URLSearchParams({
        limit: parsed.searchParams.get(limitKey) || defaultLimit,
        offset: '0',
        min_messages: '1',
        archived: 'exclude',
        order: 'recent',
        profile,
        ...extras
      })
      return params
    }

    const recents = slicePath('recents_limit', '20')
    const recentsExclude = parsed.searchParams.get('recents_exclude')
    if (recentsExclude) recents.set('exclude_sources', recentsExclude)

    const cron = slicePath('cron_limit', '50', { source: 'cron' })
    const messaging = slicePath('messaging_limit', '100')
    const messagingExclude = parsed.searchParams.get('messaging_exclude')
    if (messagingExclude) messaging.set('exclude_sources', messagingExclude)

    const [recentsResult, cronResult, messagingResult] = await Promise.all([
      requestDelegatedSessionList(runtime, { ...request, method: 'GET', path: `/api/profiles/sessions?${recents}` }, recentsProfiles, retry),
      requestDelegatedSessionList(runtime, { ...request, method: 'GET', path: `/api/profiles/sessions?${cron}` }, recentsProfiles, retry),
      requestDelegatedSessionList(runtime, { ...request, method: 'GET', path: `/api/profiles/sessions?${messaging}` }, recentsProfiles, retry)
    ])
    const errors = [
      ...(recentsResult?.errors ?? []),
      ...(cronResult?.errors ?? []),
      ...(messagingResult?.errors ?? [])
    ]
    return {
      recents: {
        profiles_truncated: recentsResult?.profiles_truncated ?? {},
        sessions: recentsResult?.sessions ?? []
      },
      cron: { sessions: cronResult?.sessions ?? [] },
      messaging: {
        sessions: messagingResult?.sessions ?? [],
        total: messagingResult?.total ?? messagingResult?.sessions?.length ?? 0
      },
      ...(errors.length ? { errors } : {})
    }
  }

  async function requestApi(request, retry = true) {
    const runtime = await ensureRuntimeEnrollment()
    const supportRequest = runtime.sessionKind === 'delegated_support'
    const parsedRequest = new URL(String(request?.path || ''), 'http://eva-managed.invalid')
    const requestPath = parsedRequest.pathname
    try {
      if (supportRequest && String(request?.method || 'GET').toUpperCase() === 'GET' &&
        requestPath === '/api/profiles' &&
        (!parsedRequest.searchParams.has('profile') || parsedRequest.searchParams.get('profile') === 'all')) {
        assertEvaManagedApiRequestAllowed({ ...request, profile: supportProfileFor(runtime, request?.profile) })
        return await requestDelegatedProfiles(runtime, request, retry)
      }
      if (supportRequest && String(request?.method || 'GET').toUpperCase() === 'GET' &&
        requestPath === '/api/profiles/sessions' && parsedRequest.searchParams.get('profile') === 'all') {
        assertEvaManagedApiRequestAllowed({ ...request, profile: supportProfileFor(runtime, request?.profile) })
        return await requestDelegatedSessionList(runtime, request, runtime.allowedProfiles, retry)
      }
      if (supportRequest && requestPath === '/api/profiles/sessions/sidebar') {
        return await requestDelegatedSidebar(runtime, request, retry)
      }
      if (supportRequest && String(request?.method || 'GET').toUpperCase() === 'GET' &&
        requestPath === '/api/profiles/projects/tree' && !parsedRequest.searchParams.has('profile')) {
        assertEvaManagedApiRequestAllowed({ ...request, profile: supportProfileFor(runtime, request?.profile) })
        return await requestDelegatedProjectTree(runtime, request, retry)
      }
      if (supportRequest && String(request?.method || 'GET').toUpperCase() === 'POST' &&
        requestPath === '/api/profiles/sessions/pull-requests' && !parsedRequest.searchParams.has('profile')) {
        assertEvaManagedApiRequestAllowed({ ...request, profile: supportProfileFor(runtime, request?.profile) })
        return await requestDelegatedPullRequests(runtime, request, retry)
      }
    } catch (error) {
      // A successful leaf 401 refresh invalidates earlier generation guards.
      // Restart only these read aggregates, once, under the same live lease.
      // End/sign-out, a new target, and real expiry must never be retried.
      const current = readState().delegatedSupport
      if (!retry || error?.code !== 'support-session-expired' || !current ||
        current.supportSessionId !== runtime.supportSessionId || expiresSoon(current.supportExpiresAt, 0, now())) throw error
      assertSupportResumeMatches(runtime, current)
      return requestApi(request, false)
    }
    const bound = bindSupportRequest(runtime, request)
    const allowed = assertEvaManagedApiRequestAllowed(bound.profile ? { ...bound.request, profile: bound.profile } : bound.request, bound.policy)
    const timeoutMs = options.resolveTimeoutMs(request?.timeoutMs)
    const guard = startSupportRequestGuard(runtime)
    try {
      const result = await options.fetchJson(`${runtime.baseUrl}${allowed.path}`, runtime.token, {
        method: allowed.method,
        body: bound.request?.body,
        upload: request?.upload,
        timeoutMs,
        signal: guard?.controller.signal
      })
      assertSupportRequestCurrent(guard)
      return result
    } catch (error) {
      const normalizedError = normalizeSupportRequestError(error, guard)
      if (guard && normalizedError?.code === 'support-session-expired') throw normalizedError
      if (!retry || statusCodeOf(normalizedError) !== 401) throw normalizedError
      finishSupportRequestGuard(guard)
      clearRuntimeEnrollment()
      const refreshed = await ensureRuntimeEnrollment({ force: true })
      if (supportRequest && refreshed.sessionKind !== 'delegated_support') {
        throw supportSessionExpiredError()
      }
      const nextBound = bindSupportRequest(refreshed, request)
      const next = assertEvaManagedApiRequestAllowed(
        nextBound.profile ? { ...nextBound.request, profile: nextBound.profile } : nextBound.request,
        nextBound.policy
      )
      const refreshedGuard = startSupportRequestGuard(refreshed)
      try {
        const result = await options.fetchJson(`${refreshed.baseUrl}${next.path}`, refreshed.token, {
          method: next.method,
          body: nextBound.request?.body,
          upload: request?.upload,
          timeoutMs,
          signal: refreshedGuard?.controller.signal
        })
        assertSupportRequestCurrent(refreshedGuard)
        return result
      } catch (retryError) {
        throw normalizeSupportRequestError(retryError, refreshedGuard)
      } finally {
        finishSupportRequestGuard(refreshedGuard)
      }
    } finally {
      finishSupportRequestGuard(guard)
    }
  }

  async function requestMedia(request, retry = true) {
    if (typeof options.fetchMedia !== 'function') {
      throw new EvaBrokerError('Managed media streaming is unavailable.', 501, 'managed-media-unavailable')
    }

    const runtime = await ensureRuntimeEnrollment()
    const supportRequest = runtime.sessionKind === 'delegated_support'
    const profile = supportProfileFor(runtime, request?.profile)
    const allowed = assertEvaManagedApiRequestAllowed({
      method: 'GET',
      path: request?.path,
      profile
    }, runtime.sessionKind === 'delegated_support' ? { allowBroadProfileSelectors: false } : undefined)
    if (allowed.pathname !== '/api/files/download') {
      throw new EvaBrokerError('Managed media streaming blocked an unsupported endpoint.', 403, 'managed-policy')
    }

    let guard = startSupportRequestGuard(runtime)
    try {
      const response = await options.fetchMedia(
        `${runtime.baseUrl}${allowed.path}`,
        runtime.token,
        request?.headers,
        guard?.controller.signal
      )
      assertSupportRequestCurrent(guard)
      if (retry && response?.status === 401) {
        finishSupportRequestGuard(guard)
        guard = null
        clearRuntimeEnrollment()
        const refreshed = await ensureRuntimeEnrollment({ force: true })
        if (supportRequest && refreshed.sessionKind !== 'delegated_support') {
          throw supportSessionExpiredError()
        }
        const refreshedProfile = supportProfileFor(refreshed, request?.profile)
        const next = assertEvaManagedApiRequestAllowed({
          method: 'GET',
          path: request?.path,
          profile: refreshedProfile
        }, refreshed.sessionKind === 'delegated_support' ? { allowBroadProfileSelectors: false } : undefined)
        const refreshedGuard = startSupportRequestGuard(refreshed)
        try {
          const refreshedResponse = await options.fetchMedia(
            `${refreshed.baseUrl}${next.path}`,
            refreshed.token,
            request?.headers,
            refreshedGuard?.controller.signal
          )
          assertSupportRequestCurrent(refreshedGuard)
          return refreshedResponse
        } catch (error) {
          finishSupportRequestGuard(refreshedGuard)
          throw normalizeSupportRequestError(error, refreshedGuard)
        }
      }
      // Keep the delegated controller registered for the lifetime of the
      // support session so ending, revocation, or expiry also aborts an active
      // streaming body after its response headers have arrived.
      if (!guard) finishSupportRequestGuard(guard)
      return response
    } catch (error) {
      finishSupportRequestGuard(guard)
      throw normalizeSupportRequestError(error, guard)
    }
  }

  async function close() {
    invalidateAuthWork()
    const relay = wsRelay
    wsRelay = null
    await relay?.close()
    rememberLog('[eva-managed] local relay closed')
  }

  const initialState = readState()
  if (initialState.rendererCleanupPending) rendererResetPending = true
  if (initialState.delegatedSupportNeedsClear) {
    clearDelegatedSupportState(initialState)
  } else if (initialState.delegatedSupport) {
    armSupportExpiryTimer(initialState.delegatedSupport)
  } else {
    clearSupportExpiryTimer()
  }
  // A handle left by a crash mid-start or a sign-out that could not reach the
  // broker: end it now if the credential is readable, else on the next sign-in.
  if (initialState.supportLease) void retrySupportLeaseCleanup(initialState).catch(() => false)

  return {
    delegatedProfiles: async () => {
      const runtime = await ensureRuntimeEnrollment()
      return runtime.sessionKind === 'delegated_support' ? [...runtime.allowedProfiles] : null
    },
    claimSupportRequest,
    close,
    completeCallback,
    endSupportSession: endDelegatedSupport,
    flushPendingRendererReset,
    listSupportTargets,
    startDelegatedSupport,
    freshWsUrl: async (input = {}) => {
      const request = typeof input === 'string' ? { profile: input } : input
      const runtime = await ensureRuntimeEnrollment()
      const profile = supportProfileFor(runtime, request.profile)
      return getWsRelay().mintTicket({
        generation: runtimeSessionGeneration,
        path: normalizeEvaWsEndpoint(request.path).path,
        profile
      })
    },
    requestApi,
    requestMedia,
    resolveBackend,
    signIn: async () => {
      const status = await signIn()
      // claimSupportRequest already isolated and reloaded this window.
      if (!status.delegatedSupportActive) await resetRenderer()
      return status
    },
    signOut,
    switchSupportTarget,
    refresh,
    status: () => publicEvaEnrollmentStatus({ ...currentState(), supportEndError, missingAgentBinding })
  }
}

module.exports = { createEvaManagedRuntime }
