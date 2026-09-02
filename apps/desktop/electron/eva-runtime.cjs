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
const SUPPORT_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

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
  let pendingAuth = null
  let authGeneration = 0
  let runtimeGeneration = 0
  let runtimeSessionGeneration = 0
  let wsRelay = null
  let supportRevalidated = false
  let supportExpiryTimer = null
  let supportExpiryTimestamp = null
  let supportEndError = null
  let rendererResetPending = false
  let rendererResetPromise = null
  const supportRequestControllers = new Set()

  function emptyState(signedOut = false) {
    return { desktop: null, runtime: null, delegatedSupport: null, signedOut }
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
    try {
      desktop = normalizeDesktopSession({
        desktop_session: options.decryptSecret(parsed.desktop?.token),
        desktop_session_expires_at: parsed.desktop?.expires_at,
        email: parsed.desktop?.email
      })
    } catch {
      desktop = null
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
    let delegatedSupportNeedsClear = Boolean(parsed.delegated_support?.enrollment && !desktop)
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
      rendererCleanupPending: parsed.renderer_cleanup_pending === true,
      signedOut: parsed.signed_out === true
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
    if (!state?.desktop) {
      if (!state?.signedOut && !state?.rendererCleanupPending) {
        fs.rmSync(statePath, { force: true })
        return
      }
      atomicWrite({
        schema_version: EVA_MANAGED_POLICY.schemaVersion,
        signed_out: state?.signedOut === true,
        ...(state.rendererCleanupPending ? { renderer_cleanup_pending: true } : {})
      })
      return
    }

    atomicWrite({
      schema_version: EVA_MANAGED_POLICY.schemaVersion,
      signed_out: false,
      ...(state.rendererCleanupPending ? { renderer_cleanup_pending: true } : {}),
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
                  agent_display_name: state.delegatedSupport.agentDisplayName
                },
                session_kind: state.delegatedSupport.sessionKind,
                support_session_id: state.delegatedSupport.supportSessionId,
                assignment_version: state.delegatedSupport.assignmentVersion,
                admin_bypass: state.delegatedSupport.adminBypass,
                support_expires_at: state.delegatedSupport.supportExpiresAt,
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
          if (state.rendererCleanupPending) writeState({ ...state, rendererCleanupPending: false })
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

  function clearDelegatedSupportState(
    state = currentState(),
    { resetRendererState = true, invalidateEnrollment = true } = {}
  ) {
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
      signedOut: state.signedOut
    })
    resetConnection()
    wsRelay?.disconnectAll()
    if (resetRendererState) return requestRendererReset()
    return Promise.resolve(true)
  }

  function supportProfileFor(runtime, requestedProfile) {
    const requested = normalizeEvaWsProfile(requestedProfile)
    if (runtime?.sessionKind === 'delegated_support') {
      if (requested !== null && requested !== runtime.profile) {
        throw new EvaBrokerError(
          'evaOS Agent rejected a profile outside the support assignment.',
          403,
          'support-profile-mismatch'
        )
      }
      return runtime.profile ?? null
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
    runtimeEnrollmentFailure = null
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

  async function beginSignIn() {
    if (signInPromise) return signInPromise

    const generation = authGeneration
    const task = (async () => {
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
        await options.openExternal(buildEvaDesktopAuthUrl(codeChallenge, authState))
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
        const desktop = await pollDeviceCode(deviceCode, verifier, { signal: controller.signal })
        controller.abort()
        assertGeneration(generation)
        writeState({ desktop, runtime: null, delegatedSupport: null })
        await advanceBootProgress('eva.authorized', 'Electric Sheep sign-in complete', 22)
        return desktop
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
        message: 'Sign in to evaOS Agent from Settings.',
        progress: 8,
        running: false,
        error: null
      },
      { allowDecrease: true }
    )
    throw new EvaBrokerError('Sign in to evaOS Agent from Settings.', 401, 'sign-in-required')
  }

  async function ensureDesktopSession() {
    const state = currentState()
    if (state.desktop && !expiresSoon(state.desktop.expiresAt, 0)) return state.desktop
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
      Date.parse(resumed.supportExpiresAt) > Date.parse(previous.supportExpiresAt)
    ) {
      throw new EvaBrokerError('evaOS Agent rejected a changed support assignment.', 403, 'support-assignment-mismatch')
    }
  }

  async function resumeDelegatedSupport(desktop, previous, auth, runtime) {
    const payload = await postBroker(
      {
        action: 'internal_support_session_resume',
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
      writeState({ desktop: latest.desktop, runtime: latest.runtime, delegatedSupport: support })
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

  async function requestDelegatedSupportEnd(state) {
    const support = state.delegatedSupport
    const desktop = state.desktop
    if (!support) return true
    if (!desktop || expiresSoon(desktop.expiresAt, 0, now())) {
      throw new EvaBrokerError('Electric Sheep desktop session expired.', 401, 'session-expired')
    }
    const result = await postBroker(
      {
        action: 'internal_support_session_end',
        support_session_id: support.supportSessionId
      },
      { desktopSession: desktop.token }
    )
    if (result?.ok !== true) {
      throw new EvaBrokerError('Electric Sheep could not end the support session.', 502, 'support-end-failed')
    }
    return true
  }

  async function endDelegatedSupport() {
    const state = currentState()
    const support = state.delegatedSupport
    if (!support) {
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
    const isolated = await clearDelegatedSupportState(state)
    if (!isolated) {
      supportEndError = true
      rememberLog('[eva-managed] support session ended but renderer isolation is still pending')
      return { ok: false }
    }
    return { ok: true }
  }

  async function ensureRuntimeEnrollment(input = {}) {
    await requireRendererIsolation()
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
          if (isRetryableEnrollmentFailure(error)) {
            recordRuntimeEnrollmentFailure(error)
          } else {
            // A deterministic broker/readiness rejection is terminal for this
            // boot attempt. Publish the safe reason before rethrowing so the
            // renderer can dismiss CONNECTING and show its recovery actions.
            recordTerminalRuntimeEnrollmentFailure(error)
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
    if (!pending) return false
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

  async function signIn() {
    await requireRendererIsolation()
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
    invalidateAuthWork()
    writeState(emptyState())
    supportRevalidated = false
    const desktop = await beginSignIn()
    const runtime = await ensureRuntimeEnrollment({ force: true })
    resetConnection()
    return publicEvaEnrollmentStatus({ desktop, runtime })
  }

  async function signOut() {
    const state = currentState()
    invalidateAuthWork()
    clearSupportExpiryTimer()
    supportEndError = null
    rendererResetPending = true
    writeState({ ...emptyState(true), rendererCleanupPending: true })
    resetConnection()
    wsRelay?.disconnectAll()
    const rendererReset = requestRendererReset()
    if (state.delegatedSupport) {
      const ended = await requestDelegatedSupportEnd(state).catch(() => false)
      if (!ended) rememberLog('[eva-managed] support session remote end failed after local sign-out')
    }
    if (state.desktop) await revokeDesktopSession(state.desktop.token).catch(() => false)
    await rendererReset
    return { ok: true }
  }

  async function refresh() {
    const previousState = currentState()
    const previousRuntime = previousState.delegatedSupport ?? previousState.runtime
    const runtime = await ensureRuntimeEnrollment({ force: true })
    const state = currentState()
    const status = publicEvaEnrollmentStatus({
      ...state,
      runtime: state.delegatedSupport ? state.runtime : runtime,
      supportEndError
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

  function bindSupportProfileValue(value, profile) {
    if (Array.isArray(value)) return value.map(entry => bindSupportProfileValue(entry, profile))
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (key !== 'profile') return [key, bindSupportProfileValue(entry, profile)]
        let requested
        try {
          requested = normalizeEvaWsProfile(entry)
        } catch {
          throw supportProfileError()
        }
        if (requested !== null && requested !== profile) throw supportProfileError()
        return [key, profile]
      })
    )
  }

  function bindSupportRequest(runtime, request) {
    const profile = supportProfileFor(runtime, request?.profile)
    if (runtime?.sessionKind !== 'delegated_support') {
      return { policy: undefined, profile, request }
    }

    return {
      policy: { allowBroadProfileSelectors: false },
      profile,
      request: {
        ...request,
        body: bindSupportProfileValue(request?.body, profile)
      }
    }
  }

  async function requestDelegatedSidebar(runtime, request, retry) {
    const parsed = new URL(String(request?.path || ''), 'http://eva-managed.invalid')
    const profile = runtime.profile
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
      requestApi({ ...request, method: 'GET', path: `/api/profiles/sessions?${recents.toString()}` }, retry),
      requestApi({ ...request, method: 'GET', path: `/api/profiles/sessions?${cron.toString()}` }, retry),
      requestApi({ ...request, method: 'GET', path: `/api/profiles/sessions?${messaging.toString()}` }, retry)
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
    const requestPath = new URL(String(request?.path || ''), 'http://eva-managed.invalid').pathname
    if (supportRequest && requestPath === '/api/profiles/sessions/sidebar') {
      return requestDelegatedSidebar(runtime, request, retry)
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

  return {
    claimSupportRequest,
    close,
    completeCallback,
    endSupportSession: endDelegatedSupport,
    flushPendingRendererReset,
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
      await resetRenderer()
      return status
    },
    signOut,
    refresh,
    status: () => publicEvaEnrollmentStatus({ ...currentState(), supportEndError })
  }
}

module.exports = { createEvaManagedRuntime }
