const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { EvaBrokerError, brokerPost, evaDesktopCodeChallenge } = require('./eva-managed.cjs')
const { createEvaManagedRuntime } = require('./eva-runtime.cjs')

const FUTURE = '2099-07-23T12:00:00.000Z'
const EXPIRED = '2020-07-23T12:00:00.000Z'

function writeEnrollment(statePath) {
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: 'evaos.eva_desktop_managed.v1',
      signed_out: false,
      desktop: {
        token: 'desktop-token',
        expires_at: FUTURE,
        email: 'employee@example.invalid'
      },
      runtime: {
        token: 'expired-runtime-token',
        expires_at: EXPIRED,
        base_url: 'https://hermes-customer-one.ecs.electricsheephq.com',
        agent_id: 'main',
        agent_display_name: 'Asuka',
        customer_id: 'customer-one',
        runtime: 'hermes'
      }
    })
  )
}

test('cold launch preserves the authorized assigned-agent display label', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-display-label-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  const runtime = makeManagedRuntime(statePath)

  assert.equal(runtime.status().agentDisplayName, 'Asuka')
})

test('cold launch re-enrolls an unexpired ES12 state that has no display label', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-legacy-display-label-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const legacy = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  delete legacy.runtime.agent_display_name
  fs.writeFileSync(statePath, JSON.stringify(legacy))

  let launches = 0
  const runtime = makeManagedRuntime(statePath, {
    launchRuntime: async () => {
      launches += 1
      return {
        agentDisplayName: 'Asuka',
        agentId: 'main',
        baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
        customerId: 'customer-one',
        expiresAt: FUTURE,
        runtime: 'hermes',
        schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
        token: 'fresh-runtime-token'
      }
    }
  })

  await runtime.resolveBackend()

  assert.equal(launches, 1)
  assert.equal(runtime.status().agentDisplayName, 'Asuka')
})

test('cold launch preserves encrypted enrollment when secure storage cannot decrypt it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-secure-storage-unreadable-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persistedBeforeLaunch = fs.readFileSync(statePath, 'utf8')
  let launches = 0
  const runtime = makeManagedRuntime(statePath, {
    // The production safeStorage wrapper converts a keychain/decryption
    // failure into an empty string before the managed runtime sees it.
    decryptSecret: () => '',
    launchRuntime: async () => {
      launches += 1
      throw new Error('runtime launch must not run without a readable desktop credential')
    }
  })

  await assert.rejects(
    runtime.resolveBackend(),
    error =>
      error instanceof EvaBrokerError &&
      error.statusCode === 503 &&
      error.code === 'managed-enrollment-unreadable'
  )

  assert.equal(launches, 0)
  assert.equal(fs.readFileSync(statePath, 'utf8'), persistedBeforeLaunch)
})

test('cold launch recovers after a deferred pre-ready secure-storage read', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-secure-storage-deferred-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persistedBeforeLaunch = fs.readFileSync(statePath, 'utf8')
  let decrypts = 0
  const runtime = makeManagedRuntime(statePath, {
    // main.ts returns an empty sentinel instead of touching macOS Keychain
    // before app.whenReady(). The next state read occurs after readiness and
    // must recover the same preserved enrollment rather than latch failure.
    decryptSecret: value => {
      decrypts += 1
      return decrypts === 1 ? '' : value
    }
  })

  const connection = await runtime.resolveBackend()

  assert.equal(connection.source, 'electric-sheep')
  assert.equal(runtime.status().agentDisplayName, 'Asuka')
  assert.ok(decrypts >= 3)
  assert.equal(fs.readFileSync(statePath, 'utf8'), persistedBeforeLaunch)
})

test('renderer cleanup preserves unreadable encrypted enrollment before returning its retry error', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-unreadable-renderer-reset-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.desktop.token = { encoding: 'safeStorage', value: 'opaque-desktop-ciphertext' }
  persisted.runtime.token = { encoding: 'safeStorage', value: 'opaque-runtime-ciphertext' }
  persisted.renderer_cleanup_pending = true
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  let launches = 0
  let resets = 0
  const runtime = makeManagedRuntime(statePath, {
    decryptSecret: () => {
      throw new Error('secure storage is unavailable')
    },
    resetRenderer: async () => {
      resets += 1
      return true
    },
    launchRuntime: async () => {
      launches += 1
      throw new Error('runtime launch must not run without a readable desktop credential')
    }
  })

  await assert.rejects(
    runtime.resolveBackend(),
    error =>
      error instanceof EvaBrokerError &&
      error.statusCode === 503 &&
      error.code === 'managed-enrollment-unreadable'
  )

  const afterReset = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const expectedAfterReset = { ...persisted }
  delete expectedAfterReset.renderer_cleanup_pending
  assert.equal(resets, 1)
  assert.equal(launches, 0)
  assert.deepEqual(afterReset, expectedAfterReset)
})

test('cold launch still requires sign-in for an expired readable desktop credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-expired-desktop-session-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const expired = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  expired.desktop.expires_at = EXPIRED
  fs.writeFileSync(statePath, JSON.stringify(expired))

  const runtime = makeManagedRuntime(statePath)

  await assert.rejects(
    runtime.resolveBackend(),
    error => error instanceof EvaBrokerError && error.code === 'sign-in-required'
  )

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.signed_out, true)
  assert.equal(persisted.desktop ?? null, null)
})

function writeActiveEnrollment(statePath) {
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: 'evaos.eva_desktop_managed.v1',
      signed_out: false,
      desktop: {
        token: 'desktop-token',
        expires_at: FUTURE,
        email: 'employee@example.invalid'
      },
      runtime: {
        token: 'runtime-token',
        expires_at: FUTURE,
        base_url: 'https://hermes-customer-one.ecs.electricsheephq.com',
        agent_id: 'main',
        agent_display_name: 'Asuka',
        customer_id: 'customer-one',
        runtime: 'hermes'
      }
    })
  )
}

function makeManagedRuntime(statePath, overrides = {}) {
  return createEvaManagedRuntime({
    statePath,
    encryptSecret: value => value,
    decryptSecret: value => value,
    waitForHermes: async () => undefined,
    fetchJson: async () => ({ ok: true }),
    createWsRelay: () => ({
      mintTicket: async () => 'ws://127.0.0.1:12345/managed',
      disconnectAll: () => undefined,
      close: async () => undefined
    }),
    resetRenderer: async () => undefined,
    resolveTimeoutMs: () => 1_000,
    ...overrides
  })
}

function supportEnrollment(now = Date.now(), overrides = {}) {
  return {
    schema_version: 'evaos.hermes_desktop_enrollment.v1',
    runtime: 'hermes',
    customer_id: 'customer-one',
    remote_backend: {
      base_url: 'https://hermes-customer-one.ecs.electricsheephq.com',
      session_token: 'opaque-support-session',
      expires_at: new Date(now + 45 * 60 * 1_000).toISOString(),
      agent_id: 'support-agent',
      agent_display_name: 'Support agent'
    },
    session_kind: 'delegated_support',
    support_session_id: 'support-session',
    assignment_version: 'assignment-v1',
    admin_bypass: false,
    support_expires_at: new Date(now + 30 * 60 * 1_000).toISOString(),
    profile: 'support',
    presentation: {
      customer_label: 'Customer',
      agent_label: 'Support agent'
    },
    ...overrides
  }
}

function sealed(value) {
  return `sealed:${Buffer.from(String(value), 'utf8').toString('base64')}`
}

function unsealed(value) {
  return Buffer.from(String(value).replace(/^sealed:/, ''), 'base64').toString('utf8')
}

function sealExistingState(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.desktop.token = sealed(state.desktop.token)
  state.runtime.token = sealed(state.runtime.token)
  fs.writeFileSync(statePath, JSON.stringify(state))
}

test('support claim separates encrypted delegated state and restores the ordinary context on end', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-lifecycle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  sealExistingState(statePath)
  const brokerCalls = []
  const requestBodies = []
  let resetRendererCalls = 0
  const runtime = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    brokerPost: async (body, options) => {
      brokerCalls.push({ body, options })
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { admin_bypass: true, assignment_version: null })
      }
      if (body.action === 'internal_support_session_end') return { ok: true }
      throw new Error('unexpected support action')
    },
    resetRenderer: async () => {
      resetRendererCalls += 1
    },
    fetchJson: async (_url, _token, options) => {
      requestBodies.push(options.body)
      return { ok: true }
    }
  })

  const claimed = await runtime.claimSupportRequest('request-123')
  assert.equal(claimed.delegatedSupportActive, true)
  assert.equal(claimed.customerId, null)
  assert.equal(claimed.agentId, null)
  assert.equal(claimed.supportCustomerLabel, 'Customer')
  assert.equal(claimed.supportAgentLabel, 'Support agent')

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.runtime.token, 'sealed:cnVudGltZS10b2tlbg==')
  assert.ok(persisted.delegated_support?.enrollment)
  assert.equal(persisted.delegated_support.enrollment.includes('opaque-support-session'), false)
  assert.equal(persisted.delegated_support.enrollment.includes('customer-one'), false)
  assert.deepEqual(JSON.parse(unsealed(persisted.delegated_support.enrollment)).presentation, {
    customer_label: 'Customer',
    agent_label: 'Support agent'
  })
  assert.equal(JSON.parse(unsealed(persisted.delegated_support.enrollment)).admin_bypass, true)
  assert.deepEqual(brokerCalls[0].body, {
    action: 'claim_internal_support_request',
    desktop_support_profiles_version: 1,
    request_id: 'request-123'
  })
  assert.equal(brokerCalls[0].options.desktopSession, 'desktop-token')
  assert.equal(Object.hasOwn(brokerCalls[0].body, 'desktop_session'), false)
  await assert.rejects(
    runtime.requestApi({ path: '/api/skills', profile: 'support', body: { nested: { profile: 'other' } } }),
    error => error instanceof EvaBrokerError && error.code === 'support-profile-mismatch'
  )
  await assert.rejects(
    runtime.requestApi({ path: '/api/skills?profile=all', profile: 'support', body: {} }),
    error => error instanceof EvaBrokerError && error.code === 'managed-escape'
  )
  await runtime.requestApi({ path: '/api/skills', profile: 'support', body: { nested: { profile: 'support' } } })
  assert.deepEqual(requestBodies.at(-1), { nested: { profile: 'support' } })
  await assert.rejects(
    runtime.resolveBackend({ profile: 'other-profile' }),
    error => error instanceof EvaBrokerError && error.code === 'support-profile-mismatch'
  )

  const ended = await runtime.endSupportSession()
  assert.deepEqual(ended, { ok: true })
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(runtime.status().customerId, 'customer-one')
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support, null)
  assert.equal(resetRendererCalls, 2)
  assert.deepEqual(brokerCalls[1].body, {
    action: 'internal_support_session_end',
    support_session_id: 'support-session'
  })
})

test('support expiry is enforced by the main-process timer without renderer polling', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-timer-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  let clock = Date.now()
  let supportExpiresAt
  let scheduled = null
  let disconnectCalls = 0
  const runtime = makeManagedRuntime(statePath, {
    now: () => clock,
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') {
        const payload = supportEnrollment(clock)
        supportExpiresAt = Date.parse(payload.support_expires_at)
        return payload
      }
      throw new Error('unexpected support action')
    },
    createWsRelay: () => ({
      mintTicket: async () => 'ws://127.0.0.1:12345/managed',
      disconnectAll: () => {
        disconnectCalls += 1
      },
      close: async () => undefined
    }),
    scheduleSupportExpiry: (callback, delay) => {
      scheduled = { callback, delay }
      return scheduled
    },
    cancelSupportExpiry: () => undefined,
    resetRenderer: async () => undefined
  })

  await runtime.claimSupportRequest('request-123')
  assert.ok(scheduled)
  assert.ok(scheduled.delay > 0)
  await runtime.resolveBackend({ profile: 'support' })

  clock = supportExpiresAt + 1
  scheduled.callback()

  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(disconnectCalls, 1)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support, null)
})

test('failed support end keeps a retryable handle and exposes a visible failure state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-end-retry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let endFails = true
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end' && endFails) {
        throw new EvaBrokerError('support end unavailable', 503, 'broker_unavailable')
      }
      return { ok: true }
    },
    resetRenderer: async () => undefined
  })

  await runtime.claimSupportRequest('request-123')
  assert.deepEqual(await runtime.endSupportSession(), { ok: false })
  assert.equal(runtime.status().delegatedSupportActive, true)
  assert.equal(runtime.status().supportEndFailed, true)
  assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support?.enrollment)

  endFails = false
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(runtime.status().supportEndFailed, false)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support, null)
})

test('support end requires an explicit positive broker acknowledgement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-end-ack-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') return null
      throw new Error('unexpected action')
    }
  })

  await runtime.claimSupportRequest('request-123')
  assert.deepEqual(await runtime.endSupportSession(), { ok: false })
  assert.equal(runtime.status().delegatedSupportActive, true)
  assert.equal(runtime.status().supportEndFailed, true)
})

test('support end cannot report success before renderer isolation completes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-end-reset-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let resetCalls = 0
  let rendererCanReset = false
  let ordinaryFetches = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') return { ok: true }
      throw new Error('unexpected action')
    },
    fetchJson: async () => {
      ordinaryFetches += 1
      return { ok: true }
    },
    resetRenderer: async () => {
      resetCalls += 1
      if (resetCalls === 1) return true
      return rendererCanReset
    }
  })

  await runtime.claimSupportRequest('request-123')
  assert.deepEqual(await runtime.endSupportSession(), { ok: false })
  assert.equal(runtime.status().delegatedSupportActive, false)
  await assert.rejects(
    runtime.requestApi({ method: 'GET', path: '/api/sessions' }),
    error => error instanceof EvaBrokerError && error.code === 'support-renderer-reset-failed'
  )
  assert.equal(ordinaryFetches, 0)
  assert.deepEqual(await runtime.endSupportSession(), { ok: false })

  rendererCanReset = true
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  await runtime.requestApi({ method: 'GET', path: '/api/sessions' })
  assert.equal(ordinaryFetches, 1)
})

test('a stale support-end completion cannot overwrite a newer sign-out', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-end-stale-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let releaseFirstEnd
  let endCalls = 0
  const firstEndStarted = new Promise(resolve => {
    releaseFirstEnd = resolve
  })
  let unblockFirstEnd
  const firstEndGate = new Promise(resolve => {
    unblockFirstEnd = resolve
  })
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        endCalls += 1
        if (endCalls === 1) {
          releaseFirstEnd()
          await firstEndGate
        }
        return { ok: true }
      }
      throw new Error('unexpected action')
    },
    revokeDesktopSession: async () => true
  })

  await runtime.claimSupportRequest('request-123')
  const ending = runtime.endSupportSession()
  await firstEndStarted
  await runtime.signOut()
  unblockFirstEnd()
  assert.deepEqual(await ending, { ok: true })

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.signed_out, true)
  assert.equal(persisted.desktop ?? null, null)
  assert.equal(persisted.runtime ?? null, null)
  assert.equal(persisted.delegated_support ?? null, null)
})

test('revoked support aborts the triggering request before ordinary enrollment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-revoked-trigger-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const first = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      throw new Error('unexpected action')
    }
  })
  await first.claimSupportRequest('request-123')
  await first.close()

  let ordinaryLaunches = 0
  const resumed = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'internal_support_session_resume') {
        throw new EvaBrokerError('support revoked', 403, 'support-revoked')
      }
      throw new Error('unexpected action')
    },
    launchRuntime: async () => {
      ordinaryLaunches += 1
      throw new Error('ordinary launch must not serve the delegated request')
    }
  })

  await assert.rejects(
    resumed.requestApi({ method: 'GET', path: '/api/sessions' }),
    error => error instanceof EvaBrokerError && error.code === 'support-session-expired'
  )
  assert.equal(ordinaryLaunches, 0)
})

test('ordinary access stays blocked until support renderer isolation succeeds', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-reset-gate-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const first = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      throw new Error('unexpected action')
    }
  })
  await first.claimSupportRequest('request-123')
  await first.close()

  let rendererCanReset = false
  let ordinaryFetches = 0
  const resumed = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'internal_support_session_resume') {
        throw new EvaBrokerError('support revoked', 403, 'support-revoked')
      }
      throw new Error('unexpected action')
    },
    fetchJson: async () => {
      ordinaryFetches += 1
      return { ok: true }
    },
    resetRenderer: async () => rendererCanReset
  })

  await assert.rejects(
    resumed.requestApi({ method: 'GET', path: '/api/sessions' }),
    error => error instanceof EvaBrokerError && error.code === 'support-session-expired'
  )
  await assert.rejects(
    resumed.requestApi({ method: 'GET', path: '/api/sessions' }),
    error => error instanceof EvaBrokerError && error.code === 'support-renderer-reset-failed'
  )
  assert.equal(ordinaryFetches, 0)

  rendererCanReset = true
  await resumed.requestApi({ method: 'GET', path: '/api/sessions' })
  assert.equal(ordinaryFetches, 1)
})

test('restart resumes only the same support assignment and rejects actor or replay failures before persistence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-resume-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  sealExistingState(statePath)
  let claimedPayload
  const first = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') {
        claimedPayload = supportEnrollment(Date.now(), { admin_bypass: true, assignment_version: null })
        return claimedPayload
      }
      throw new Error('unexpected action')
    },
    resetRenderer: async () => undefined
  })
  await first.claimSupportRequest('request-123')
  await first.close()

  const resumeCalls = []
  const second = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    brokerPost: async (body, options) => {
      resumeCalls.push({ body, options })
      return claimedPayload
    },
    launchRuntime: async () => {
      throw new Error('ordinary enrollment is not allowed before support resume')
    },
    resetRenderer: async () => undefined
  })
  const backend = await second.resolveBackend({ profile: 'support' })
  assert.equal(backend.baseUrl, 'eva-managed://delegated-support')
  assert.equal(resumeCalls.length, 1)
  assert.deepEqual(resumeCalls[0].body, {
    action: 'internal_support_session_resume',
    desktop_support_profiles_version: 1,
    support_session_id: 'support-session'
  })
  assert.equal(resumeCalls[0].options.desktopSession, 'desktop-token')
  await second.close()

  const actorMismatch = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    brokerPost: async () => {
      throw new EvaBrokerError('support assignment was revoked', 403, 'support_assignment_revoked')
    },
    launchRuntime: async () => ({
      schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
      customerId: 'customer-one',
      runtime: 'hermes',
      agentId: 'main',
      baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
      token: 'ordinary-runtime',
      expiresAt: FUTURE
    }),
    resetRenderer: async () => undefined
  })
  await assert.rejects(
    actorMismatch.resolveBackend(),
    error => error instanceof EvaBrokerError && error.code === 'support-session-expired'
  )
  const restored = await actorMismatch.resolveBackend()
  assert.equal(restored.baseUrl, 'eva-managed://customer-one')
  assert.equal(actorMismatch.status().delegatedSupportActive, false)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support, null)
})

test('expired delegated support state is cleared without harming ordinary enrollment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-expiry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  sealExistingState(statePath)
  const expired = supportEnrollment(Date.now() - 60 * 60 * 1_000)
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(statePath, 'utf8')),
      delegated_support: { enrollment: sealed(JSON.stringify(expired)) }
    })
  )
  const runtime = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    resetRenderer: async () => undefined
  })
  const status = runtime.status()
  assert.equal(status.delegatedSupportActive, false)
  assert.equal(status.customerId, 'customer-one')
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support, null)
})

test('cold expired support defers renderer cleanup until a window can perform it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-cold-reset-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  sealExistingState(statePath)
  const expired = supportEnrollment(Date.now() - 60 * 60 * 1_000)
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(statePath, 'utf8')),
      delegated_support: { enrollment: sealed(JSON.stringify(expired)) }
    })
  )

  let rendererAvailable = false
  let resets = 0
  const runtime = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    resetRenderer: async () => {
      resets += 1
      return rendererAvailable
    }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resets, 1)

  rendererAvailable = true
  assert.equal(await runtime.flushPendingRendererReset(), true)
  assert.equal(resets, 2)
  assert.equal(await runtime.flushPendingRendererReset(), false)
})

test('renderer cleanup tombstone survives restart until a window confirms isolation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-reset-restart-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  sealExistingState(statePath)
  const expired = supportEnrollment(Date.now() - 60 * 60 * 1_000)
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(statePath, 'utf8')),
      delegated_support: { enrollment: sealed(JSON.stringify(expired)) }
    })
  )

  const first = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    resetRenderer: async () => false
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).renderer_cleanup_pending, true)
  await first.close()

  let resets = 0
  const second = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    resetRenderer: async () => {
      resets += 1
      return true
    }
  })
  assert.equal(await second.flushPendingRendererReset(), true)
  assert.equal(resets, 1)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).renderer_cleanup_pending, undefined)
})

test('renderer cleanup tombstone survives cold stale support with no desktop session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-reset-no-desktop-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: 'evaos.eva_desktop_managed.v1',
      signed_out: false,
      delegated_support: { enrollment: sealed(JSON.stringify(supportEnrollment())) }
    })
  )

  const first = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    resetRenderer: async () => false
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fs.existsSync(statePath), true)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).renderer_cleanup_pending, true)
  await first.close()

  const second = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    resetRenderer: async () => true
  })
  assert.equal(await second.flushPendingRendererReset(), true)
  assert.equal(fs.existsSync(statePath), false)
})

test('delegated sidebar requests are split into exact-profile session slices', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-sidebar-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const urls = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      throw new Error('unexpected action')
    },
    fetchJson: async url => {
      urls.push(url)
      const parsed = new URL(url)
      const source = parsed.searchParams.get('source')
      return {
        sessions: [{ id: source === 'cron' ? 'cron' : parsed.searchParams.has('exclude_sources') ? 'messaging' : 'recent' }],
        total: 1
      }
    }
  })
  await runtime.claimSupportRequest('request-123')

  const result = await runtime.requestApi({
    method: 'GET',
    path: '/api/profiles/sessions/sidebar?recents_profile=support&recents_limit=30&cron_limit=40&messaging_limit=50&recents_exclude=cron&messaging_exclude=cron'
  })

  assert.equal(urls.length, 3)
  assert.ok(urls.every(url => new URL(url).pathname === '/api/profiles/sessions'))
  assert.ok(urls.every(url => new URL(url).searchParams.get('profile') === 'support'))
  assert.ok(urls.every(url => !url.includes('profile=all')))
  assert.deepEqual(result.recents.sessions, [{ id: 'messaging', profile: 'support' }])
  assert.deepEqual(result.cron.sessions, [{ id: 'cron', profile: 'support' }])
  assert.deepEqual(result.messaging.sessions, [{ id: 'messaging', profile: 'support' }])
})

test('admin customer scope routes and aggregates only its granted profiles', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-scope-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  writeActiveEnrollment(statePath)
  const payload = supportEnrollment()
  payload.admin_bypass = true
  payload.assignment_version = null
  payload.remote_backend.allowed_profiles = ['support', 'sibling']
  const paths = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => payload,
    fetchJson: async url => {
      const parsed = new URL(url)
      paths.push(parsed)
      const profile = parsed.searchParams.get('profile')
      assert.ok(['support', 'sibling'].includes(profile))
      return { sessions: [{ id: `retained-${profile}`, profile }], total: 1 }
    }
  })
  t.after(() => runtime.close())
  await runtime.claimSupportRequest('scope-request')
  assert.equal((await runtime.resolveBackend({ profile: 'sibling' })).profile, 'sibling')
  assert.equal((await runtime.resolveBackend({ profile: 'default' })).profile, 'support')
  const result = await runtime.requestApi({ path: '/api/profiles/sessions?profile=all', profile: 'default' })
  assert.deepEqual(result.sessions.map(row => row.profile).sort(), ['sibling', 'support'])
  const sidebar = await runtime.requestApi({ path: '/api/profiles/sessions/sidebar', profile: 'default' })
  assert.equal(sidebar.messaging.sessions.length, 2)
  const filtered = await runtime.requestApi({ path: '/api/profiles/sessions/sidebar?recents_profile=sibling', profile: 'default' })
  assert.deepEqual(filtered.recents.sessions.map(row => row.profile), ['sibling'])
  assert.deepEqual(filtered.cron.sessions.map(row => row.profile), ['sibling'])
  assert.deepEqual(filtered.messaging.sessions.map(row => row.profile), ['sibling'])
  await runtime.requestApi({ path: '/api/skills?profile=default', profile: 'default' })
  const beforeDenial = paths.length
  await assert.rejects(runtime.requestApi({ path: '/api/skills', profile: 'outside' }), error => error.code === 'support-profile-mismatch')
  await assert.rejects(runtime.requestApi({ path: '/api/skills', profile: 'sibling', body: { profile: 'support' } }), error => error.code === 'support-profile-mismatch')
  assert.equal(paths.length, beforeDenial)
})

test('admin session pages merge recency before the global pinned-aware window', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-page-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  writeActiveEnrollment(statePath)
  const payload = supportEnrollment()
  payload.admin_bypass = true
  payload.assignment_version = null
  payload.remote_backend.allowed_profiles = ['support', 'sibling']
  const byProfile = {
    support: [{ id: 'older', profile: 'support', last_active: 10 }, { id: 'oldest', profile: 'support', last_active: 9 }],
    sibling: [{ id: 'newest', profile: 'sibling', last_active: 30 }, { id: 'next', profile: 'sibling', last_active: 20 },
      { id: 'pinned', profile: 'sibling', last_active: 1, pinned: true }]
  }
  const requests = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => payload,
    fetchJson: async url => {
      const parsed = new URL(url)
      requests.push(parsed)
      const profile = parsed.searchParams.get('profile')
      const rows = byProfile[profile]
      const limit = Number(parsed.searchParams.get('limit'))
      return { sessions: [...rows.slice(0, limit), ...rows.slice(limit).filter(row => row.pinned)],
        total: rows.length, profile_totals: { [profile]: rows.length },
        errors: profile === 'support' ? [{ profile, error: 'synthetic partial scan' }] : [] }
    }
  })
  t.after(() => runtime.close())
  await runtime.claimSupportRequest('page-request')
  const first = await runtime.requestApi({ path: '/api/profiles/sessions?profile=all&limit=2&order=recent' })
  assert.deepEqual(first.sessions.map(row => row.id), ['newest', 'next', 'pinned'])
  assert.equal(first.total, 5)
  assert.deepEqual(first.profiles_truncated, { support: true, sibling: false })
  assert.equal(first.errors.length, 1)
  const second = await runtime.requestApi({ path: '/api/profiles/sessions?profile=all&limit=2&offset=1&order=recent' })
  assert.deepEqual(second.sessions.map(row => row.id), ['next', 'older', 'pinned'])
  assert.deepEqual(requests.slice(-2).map(url => [url.searchParams.get('limit'), url.searchParams.get('offset')]), [['3', '0'], ['3', '0']])
})

test('the assigned profile id names the profile this session asked the gateway for', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-assigned-profile-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  writeActiveEnrollment(statePath)
  const ordinary = makeManagedRuntime(statePath)
  t.after(() => ordinary.close())
  // An ordinary login expects its own enrolled agent.
  assert.equal(await ordinary.assignedProfileId(), 'main')

  const supportPath = path.join(directory, 'support-state.json')
  writeActiveEnrollment(supportPath)
  // A flat managed box's profile is literally named `default`; the lease's
  // granted profile is what the app asks for, so it is the expectation.
  const payload = supportEnrollment(Date.now(), { profile: 'default' })
  payload.remote_backend.allowed_profiles = ['default']
  const support = makeManagedRuntime(supportPath, { brokerPost: async () => payload })
  t.after(() => support.close())
  await support.claimSupportRequest('assigned-profile-request')
  assert.equal(await support.assignedProfileId(), 'default')
})

test('admin profile discovery reads every granted agent even without sessions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-profiles-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  writeActiveEnrollment(statePath)
  const payload = supportEnrollment()
  payload.admin_bypass = true
  payload.assignment_version = null
  payload.remote_backend.allowed_profiles = ['support', 'quiet']
  const requests = []
  let wrongProfile = false
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => payload,
    fetchJson: async url => {
      const parsed = new URL(url)
      requests.push(parsed)
      assert.equal(parsed.pathname, '/api/profiles')
      const profile = parsed.searchParams.get('profile')
      assert.ok(['support', 'quiet'].includes(profile))
      return { profiles: [{ name: wrongProfile ? 'outside' : profile, skill_count: 3 }] }
    }
  })
  t.after(() => runtime.close())
  await runtime.claimSupportRequest('profiles-request')
  const granted = await runtime.delegatedProfiles()
  assert.deepEqual(granted, ['support', 'quiet'])
  granted.push('outside')
  assert.deepEqual(await runtime.delegatedProfiles(), ['support', 'quiet'])
  assert.deepEqual((await runtime.requestApi({ path: '/api/profiles', profile: 'default' })).profiles,
    [{ name: 'support', skill_count: 3 }, { name: 'quiet', skill_count: 3 }])
  assert.equal(requests.length, 2)
  const scoped = await runtime.requestApi({ path: '/api/profiles?profile=quiet', profile: 'quiet' })
  assert.deepEqual(scoped.profiles.map(row => row.name), ['quiet'])
  wrongProfile = true
  await assert.rejects(runtime.requestApi({ path: '/api/profiles' }), error => error.code === 'support-profile-mismatch')
})

test('admin project tree merges granted profiles and rejects mismatched session rows', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-tree-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  writeActiveEnrollment(statePath)
  const payload = supportEnrollment()
  payload.admin_bypass = true
  payload.assignment_version = null
  payload.remote_backend.allowed_profiles = ['support', 'sibling']
  let wrongProfile = false
  const requests = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => payload,
    fetchJson: async url => {
      const parsed = new URL(url)
      const profile = parsed.searchParams.get('profile')
      requests.push(profile)
      assert.ok(['support', 'sibling'].includes(profile))
      const row = { id: `retained-${profile}`, last_active: profile === 'sibling' ? 20 : 10,
        ...(wrongProfile ? { profile: 'outside' } : {}) }
      if (parsed.pathname === '/api/profiles/sessions') return { sessions: [row], total: 1 }
      assert.equal(parsed.pathname, '/api/profiles/projects/tree')
      return { projects: [{ id: profile, path: '/synthetic/shared', isAuto: profile === 'support',
        sessionCount: 1, totalTokens: 10, totalCostUsd: 0.5, lastActive: row.last_active,
        previewSessions: [row], repos: [{ id: 'repo', sessionCount: 1,
          groups: [{ id: 'lane', sessionCount: 1, sessions: [row] }] }] }],
        active_id: profile, scoped_session_ids: [row.id], errors: [] }
    }
  })
  t.after(() => runtime.close())
  await runtime.claimSupportRequest('tree-request')
  const result = await runtime.requestApi({ path: '/api/profiles/projects/tree?preview_limit=1' })
  assert.deepEqual(requests, ['support', 'sibling'])
  assert.equal(result.active_id, null)
  assert.deepEqual(result.scoped_session_ids, ['retained-support', 'retained-sibling'])
  assert.equal(result.projects.length, 1)
  const project = result.projects[0]
  assert.equal(project.id, 'sibling')
  assert.equal(project.sessionCount, 2)
  assert.equal(project.totalTokens, 20)
  assert.equal(project.totalCostUsd, 1)
  assert.deepEqual(project.previewSessions.map(row => row.profile), ['sibling'])
  assert.deepEqual(project.repos[0].groups[0].sessions.map(row => row.profile).sort(), ['sibling', 'support'])
  const sessions = await runtime.requestApi({ path: '/api/profiles/sessions?profile=all' })
  assert.deepEqual(sessions.sessions.map(row => row.profile), ['sibling', 'support'])
  wrongProfile = true
  for (const path of ['/api/profiles/projects/tree', '/api/profiles/sessions?profile=all', '/api/profiles/sessions/sidebar']) {
    await assert.rejects(runtime.requestApi({ path }), error => error.code === 'support-profile-mismatch')
  }
})

test('admin pull-request recovery scans the finite grant without permanently recording partial misses', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-pr-scan-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  writeActiveEnrollment(statePath)
  const payload = supportEnrollment()
  payload.admin_bypass = true
  payload.assignment_version = null
  payload.remote_backend.allowed_profiles = ['support', 'sibling']
  let failure = null
  const profiles = []
  const ids = ['support-session', 'sibling-session']
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => payload,
    fetchJson: async (url, _token, options) => {
      const profile = new URL(url).searchParams.get('profile')
      profiles.push(profile)
      assert.equal(options.method, 'POST')
      assert.deepEqual(options.body.ids, ids)
      if (profile === 'sibling' && failure === 'suppressed') return { pull_requests: {}, scanned: ids }
      if (profile === 'sibling' && failure) throw failure
      return { pull_requests: { [`${profile}-session`]: { number: profile === 'support' ? 1 : 2 } }, scanned: ids }
    }
  })
  t.after(() => runtime.close())
  await runtime.claimSupportRequest('pr-scan-request')
  const request = { method: 'POST', path: '/api/profiles/sessions/pull-requests', body: { ids } }
  const complete = await runtime.requestApi(request)
  assert.deepEqual(profiles, ['support', 'sibling'])
  assert.deepEqual(Object.keys(complete.pull_requests).sort(), ['sibling-session', 'support-session'])
  assert.deepEqual(complete.scanned, ids)
  failure = new EvaBrokerError('private upstream detail', 503, 'unavailable')
  const partial = await runtime.requestApi(request)
  assert.deepEqual(partial.scanned, [])
  assert.equal(partial.pull_requests['support-session'].number, 1)
  assert.ok(partial.errors.some(error => error.profile === 'sibling'))
  assert.equal(JSON.stringify(partial).includes('private upstream detail'), false)
  failure = 'suppressed'
  const suppressed = await runtime.requestApi(request)
  assert.deepEqual(suppressed.scanned, ['support-session'])
  failure = new EvaBrokerError('permission revoked', 403, 'forbidden')
  await assert.rejects(runtime.requestApi(request), error => error.statusCode === 403)
})

test('admin aggregate reads isolate unavailable profiles but reject authorization failures', async t => {
  for (const requestPath of ['/api/profiles', '/api/profiles/projects/tree', '/api/profiles/sessions?profile=all', '/api/profiles/sessions/sidebar']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-partial-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const statePath = path.join(directory, 'state.json')
    writeActiveEnrollment(statePath)
    const payload = supportEnrollment()
    payload.admin_bypass = true
    payload.assignment_version = null
    payload.remote_backend.allowed_profiles = ['support', 'sibling']
    let failure = new EvaBrokerError('synthetic private upstream detail', 503, 'upstream_unavailable')
    const runtime = makeManagedRuntime(statePath, {
      brokerPost: async () => payload,
      fetchJson: async url => {
        const parsed = new URL(url)
        const profile = parsed.searchParams.get('profile')
        if (profile === 'support') throw failure
        if (parsed.pathname === '/api/profiles/projects/tree') return { projects: [{ id: profile }], errors: [] }
        return parsed.pathname === '/api/profiles'
          ? { profiles: [{ name: profile }] }
          : { sessions: [{ id: profile, profile }], total: 1 }
      }
    })
    t.after(() => runtime.close())
    await runtime.claimSupportRequest('partial-request')
    for (const error of [failure, new Error('synthetic private network detail')]) {
      failure = error
      const result = await runtime.requestApi({ path: requestPath })
      assert.equal((result.profiles ?? result.projects ?? result.sessions ?? result.recents.sessions).length, 1)
      assert.ok(result.errors.some(entry => entry.profile === 'support'))
      assert.equal(JSON.stringify(result).includes('synthetic private'), false)
    }
    failure = new EvaBrokerError('authorization revoked', 403, 'forbidden')
    await assert.rejects(runtime.requestApi({ path: requestPath }), error => error.statusCode === 403)
  }
})

test('admin discovery retains last-good rows on transport and reported failures only inside the same support lease', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-cache-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  writeActiveEnrollment(statePath)
  let payload = supportEnrollment()
  payload.admin_bypass = true
  payload.assignment_version = null
  payload.remote_backend.allowed_profiles = ['support', 'sibling']
  let unavailable = false
  let revision = 1
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => body.action === 'internal_support_session_end' ? { ok: true } : payload,
    fetchJson: async url => {
      const parsed = new URL(url)
      const profile = parsed.searchParams.get('profile')
      if (unavailable && profile === 'sibling') {
        if (unavailable === 'reported') return parsed.pathname === '/api/profiles'
          ? { profiles: [] }
          : { projects: [], scoped_session_ids: [], errors: [{ profile, error: 'Profile database unavailable.' }] }
        throw new EvaBrokerError('private upstream detail', 503, 'unavailable')
      }
      return parsed.pathname === '/api/profiles'
        ? { profiles: [{ name: profile, display_name: `${profile}-${revision}` }] }
        : { projects: [{ id: profile, name: `${profile}-${revision}`, sessionCount: 1,
          repos: [{ id: 'repo', groups: [{ id: 'lane', sessions: [{ id: profile, profile }] }] }] }] }
    }
  })
  t.after(() => runtime.close())
  await runtime.claimSupportRequest('cache-request')
  const paths = ['/api/profiles', '/api/profiles/projects/tree']
  for (const path of paths) await runtime.requestApi({ path })
  revision = 2
  for (const failure of ['transport', 'reported']) {
    unavailable = failure
    for (const path of paths) {
      const partial = await runtime.requestApi({ path })
      const rows = partial.profiles ?? partial.projects
      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map(row => row.display_name ?? row.name), ['support-2', 'sibling-1'])
      assert.ok(partial.errors.some(error => error.profile === 'sibling'))
      assert.equal(JSON.stringify(partial).includes('private upstream detail'), false)
    }
  }
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  payload = { ...payload, support_session_id: 'next-support-session' }
  await runtime.claimSupportRequest('next-cache-request')
  for (const path of paths) {
    const fresh = await runtime.requestApi({ path })
    assert.equal((fresh.profiles ?? fresh.projects).length, 1)
    assert.equal(JSON.stringify(fresh).includes('sibling-1'), false)
  }
})

test('admin aggregate reads recover once after same-grant credential refresh', async t => {
  for (const requestPath of ['/api/profiles', '/api/profiles/projects/tree', '/api/profiles/sessions?profile=all', '/api/profiles/sessions/sidebar']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-aggregate-refresh-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const statePath = path.join(directory, 'state.json')
    writeActiveEnrollment(statePath)
    const payload = supportEnrollment()
    payload.admin_bypass = true
    payload.assignment_version = null
    payload.remote_backend.allowed_profiles = ['support', 'sibling']
    let fetchCount = 0
    let resumes = 0
    const runtime = makeManagedRuntime(statePath, {
      brokerPost: async body => {
        if (body.action === 'internal_support_session_resume') resumes += 1
        return payload
      },
      fetchJson: async url => {
        if (++fetchCount === 1) throw new EvaBrokerError('refresh required', 401, 'session_expired')
        const parsed = new URL(url)
        const profile = parsed.searchParams.get('profile')
        if (parsed.pathname === '/api/profiles/projects/tree') return { projects: [{ id: profile }], errors: [] }
        return parsed.pathname === '/api/profiles'
          ? { profiles: [{ name: profile }] }
          : { sessions: [{ id: profile, profile }], total: 1 }
      }
    })
    t.after(() => runtime.close())
    await runtime.claimSupportRequest('aggregate-refresh-request')
    const result = await runtime.requestApi({ path: requestPath })
    assert.equal((result.profiles ?? result.projects ?? result.sessions ?? result.recents.sessions).length, 2)
    assert.equal(resumes, 1)
    assert.equal(runtime.status().delegatedSupportActive, true)
  }
})

test('support readiness 401 revalidates the same delegated assignment without ordinary fallback', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-readiness-401-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let readinessCalls = 0
  let resumeCalls = 0
  let ordinaryLaunches = 0
  const enrollment = supportEnrollment()
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return enrollment
      if (body.action === 'internal_support_session_resume') {
        resumeCalls += 1
        return enrollment
      }
      throw new Error('unexpected action')
    },
    waitForHermes: async () => {
      readinessCalls += 1
      if (readinessCalls === 1) {
        throw new EvaBrokerError('support runtime rejected', 401, 'session_expired')
      }
    },
    launchRuntime: async () => {
      ordinaryLaunches += 1
      throw new Error('ordinary enrollment must not replace delegated support')
    }
  })
  await runtime.claimSupportRequest('request-123')

  const backend = await runtime.resolveBackend({ profile: 'support' })
  assert.equal(backend.profile, 'support')
  assert.equal(runtime.status().delegatedSupportActive, true)
  assert.equal(resumeCalls, 1)
  assert.equal(ordinaryLaunches, 0)
})

test('delegated API 401 preserves the support handle and retries only after broker revalidation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-api-401-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let brokerResumes = 0
  let fetches = 0
  let ordinaryLaunches = 0
  const enrollment = supportEnrollment()
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return enrollment
      if (body.action === 'internal_support_session_resume') {
        brokerResumes += 1
        return enrollment
      }
      throw new Error('unexpected action')
    },
    fetchJson: async () => {
      fetches += 1
      if (fetches === 1) throw new EvaBrokerError('runtime token rejected', 401, 'session_expired')
      return { ok: true }
    },
    launchRuntime: async () => {
      ordinaryLaunches += 1
      throw new Error('ordinary enrollment must not replace delegated support')
    }
  })

  await runtime.claimSupportRequest('request-123')
  assert.deepEqual(
    await runtime.requestApi({ method: 'GET', path: '/api/sessions', profile: 'support' }),
    { ok: true }
  )
  assert.equal(fetches, 2)
  assert.equal(brokerResumes, 1)
  assert.equal(ordinaryLaunches, 0)
  assert.equal(runtime.status().delegatedSupportActive, true)
})

test('claim actor mismatch or replay failure leaves ordinary enrollment untouched', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-claim-rejected-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  sealExistingState(statePath)
  const runtime = makeManagedRuntime(statePath, {
    encryptSecret: sealed,
    decryptSecret: unsealed,
    brokerPost: async () => {
      throw new EvaBrokerError('support claim rejected', 409, 'support_request_replayed')
    },
    resetRenderer: async () => undefined
  })

  await assert.rejects(
    runtime.claimSupportRequest('request-123'),
    error => error instanceof EvaBrokerError && error.code === 'support_request_replayed'
  )
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.delegated_support, undefined)
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(runtime.status().customerId, 'customer-one')
})

test('a late support claim cannot restore a signed-out employee session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-signout-race-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  let releaseClaim
  let markClaimStarted
  let remoteEnds = 0
  const claimStarted = new Promise(resolve => {
    markClaimStarted = resolve
  })
  const claimGate = new Promise(resolve => {
    releaseClaim = resolve
  })
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') {
        markClaimStarted()
        await claimGate
        return supportEnrollment()
      }
      if (body.action === 'internal_support_session_end') {
        remoteEnds += 1
        return { ok: true }
      }
      throw new Error('unexpected action')
    },
    revokeDesktopSession: async () => true,
    resetRenderer: async () => undefined
  })

  const claim = runtime.claimSupportRequest('request-123')
  await claimStarted
  assert.deepEqual(await runtime.signOut(), { ok: true })
  releaseClaim()

  await assert.rejects(claim, error => error instanceof EvaBrokerError && error.code === 'stale-auth')
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.signed_out, true)
  assert.equal(persisted.desktop ?? null, null)
  assert.equal(persisted.delegated_support ?? null, null)
  assert.equal(remoteEnds, 1)
})

test('a late support claim cannot overwrite a replacement sign-in attempt', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-signin-race-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  let releaseClaim
  let markClaimStarted
  const claimStarted = new Promise(resolve => {
    markClaimStarted = resolve
  })
  const claimGate = new Promise(resolve => {
    releaseClaim = resolve
  })
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') {
        markClaimStarted()
        await claimGate
        return supportEnrollment()
      }
      if (body.action === 'internal_support_session_end') return { ok: true }
      throw new Error('unexpected action')
    },
    loginTimeoutMs: 1_000,
    openExternal: async () => undefined,
    resetRenderer: async () => undefined
  })

  const claim = runtime.claimSupportRequest('request-123')
  await claimStarted
  const replacement = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  releaseClaim()

  await assert.rejects(claim, error => error instanceof EvaBrokerError && error.code === 'stale-auth')
  await runtime.close()
  await assert.rejects(replacement, error => error instanceof EvaBrokerError && error.code === 'stale-auth')
  assert.equal(fs.existsSync(statePath), false)
})

test('renderer reset failure refuses and remotely ends a claimed support session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-renderer-reset-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let remoteEnds = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        remoteEnds += 1
        return { ok: true }
      }
      throw new Error('unexpected action')
    },
    resetRenderer: async () => {
      throw new Error('renderer reset failed')
    }
  })

  await assert.rejects(
    runtime.claimSupportRequest('request-123'),
    error => error instanceof EvaBrokerError && error.code === 'support-renderer-reset-failed'
  )
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.delegated_support, undefined)
  assert.equal(persisted.runtime.token, 'runtime-token')
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(remoteEnds, 1)
})

test('renderer reset returning false refuses and remotely ends a claimed support session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-renderer-unavailable-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let remoteEnds = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        remoteEnds += 1
        return { ok: true }
      }
      throw new Error('unexpected action')
    },
    resetRenderer: async () => false
  })

  await assert.rejects(
    runtime.claimSupportRequest('request-123'),
    error => error instanceof EvaBrokerError && error.code === 'support-renderer-reset-failed'
  )
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(remoteEnds, 1)
})

test('ending delegated support aborts and rejects an in-flight JSON request', async t => {
  for (const requestPath of ['/api/sessions', '/api/profiles', '/api/profiles/sessions?profile=all']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-request-abort-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const statePath = path.join(directory, 'eva-enrollment.json')
    writeActiveEnrollment(statePath)
    let releaseFetch
    let requestSignal
    const fetchGate = new Promise(resolve => {
      releaseFetch = resolve
    })
    const runtime = makeManagedRuntime(statePath, {
      brokerPost: async body => {
        if (body.action === 'claim_internal_support_request') return supportEnrollment()
        if (body.action === 'internal_support_session_end') return { ok: true }
        throw new Error('unexpected action')
      },
      fetchJson: async (_url, _token, options) => {
        requestSignal = options.signal
        await fetchGate
        return { customer: 'must-not-escape' }
      }
    })

    await runtime.claimSupportRequest('request-123')
    const request = runtime.requestApi({ method: 'GET', path: requestPath, profile: 'support' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requestSignal?.aborted, false)
    assert.deepEqual(await runtime.endSupportSession(), { ok: true })
    assert.equal(requestSignal.aborted, true)
    releaseFetch()
    await assert.rejects(
      request,
      error => error instanceof EvaBrokerError && error.code === 'support-session-expired'
    )
    await runtime.close()
  }
})

test('ending delegated support aborts and rejects an in-flight media request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-media-abort-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let releaseFetch
  let requestSignal
  const fetchGate = new Promise(resolve => {
    releaseFetch = resolve
  })
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') return { ok: true }
      throw new Error('unexpected action')
    },
    fetchMedia: async (_url, _token, _headers, signal) => {
      requestSignal = signal
      await fetchGate
      return { status: 200 }
    }
  })

  await runtime.claimSupportRequest('request-123')
  const request = runtime.requestMedia({
    path: '/api/files/download?path=%2Fsrv%2Fsupport.mp3',
    profile: 'support'
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requestSignal?.aborted, false)
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  assert.equal(requestSignal.aborted, true)
  releaseFetch()
  await assert.rejects(
    request,
    error => error instanceof EvaBrokerError && error.code === 'support-session-expired'
  )
})

test('sign-out severs local support access even when the remote end call fails', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-signout-fail-closed-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let disconnects = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        throw new EvaBrokerError('support end unavailable', 503, 'broker_unavailable')
      }
      throw new Error('unexpected action')
    },
    createWsRelay: () => ({
      mintTicket: async () => 'ws://127.0.0.1:12345/managed',
      disconnectAll: () => {
        disconnects += 1
      },
      close: async () => undefined
    }),
    revokeDesktopSession: async () => false,
    resetRenderer: async () => undefined
  })

  await runtime.claimSupportRequest('request-123')
  await runtime.resolveBackend({ profile: 'support' })
  assert.deepEqual(await runtime.signOut(), { ok: true })

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.signed_out, true)
  assert.equal(persisted.desktop ?? null, null)
  assert.equal(persisted.runtime ?? null, null)
  assert.equal(persisted.delegated_support ?? null, null)
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.ok(disconnects >= 1)
})

test('sign-out starts renderer isolation before remote support cleanup settles', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-support-signout-order-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let releaseSupportEnd
  const supportEndGate = new Promise(resolve => {
    releaseSupportEnd = resolve
  })
  let rendererResetStarted = false
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        await supportEndGate
        return { ok: true }
      }
      throw new Error('unexpected action')
    },
    revokeDesktopSession: async () => true,
    resetRenderer: async () => {
      rendererResetStarted = true
    }
  })

  await runtime.claimSupportRequest('request-123')
  const signOut = runtime.signOut()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rendererResetStarted, true)
  releaseSupportEnd()
  assert.deepEqual(await signOut, { ok: true })
})

test('cold launch replaces an expired runtime enrollment before connecting', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-expiry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)

  let launches = 0
  const runtime = createEvaManagedRuntime({
    statePath,
    encryptSecret: value => value,
    decryptSecret: value => value,
    launchRuntime: async token => {
      launches += 1
      assert.equal(token, 'desktop-token')
      return {
        schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
        customerId: 'customer-one',
        runtime: 'hermes',
        agentId: 'main',
        baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
        token: 'fresh-runtime-token',
        expiresAt: FUTURE
      }
    },
    waitForHermes: async () => undefined,
    createWsRelay: () => ({
      mintTicket: async () => 'ws://127.0.0.1:12345/managed',
      disconnectAll: () => undefined,
      close: async () => undefined
    }),
    resolveTimeoutMs: () => 1_000
  })

  const backend = await runtime.resolveBackend()
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))

  assert.equal(launches, 1)
  assert.equal(backend.mode, 'remote')
  assert.equal(backend.baseUrl, 'eva-managed://customer-one')
  assert.equal(persisted.runtime.token, 'fresh-runtime-token')
  assert.equal(persisted.runtime.expires_at, FUTURE)
})

for (const [statusCode, errorCode] of [[408, 'broker_timeout'], [429, 'rate_limited']]) {
  test(`HTTP ${statusCode} runtime enrollment waits for the shared retry cooldown`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `eva-runtime-backoff-${statusCode}-`))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const statePath = path.join(directory, 'eva-enrollment.json')
    writeEnrollment(statePath)

    let clock = 0
    let launches = 0
    const failure = new EvaBrokerError('Runtime enrollment is temporarily unavailable.', statusCode, errorCode)
    const runtime = makeManagedRuntime(statePath, {
      now: () => clock,
      launchRuntime: async () => {
        launches += 1
        throw failure
      }
    })

    const first = await Promise.allSettled([
      runtime.resolveBackend(),
      runtime.requestApi({ path: '/api/sessions', method: 'GET' }),
      runtime.freshWsUrl()
    ])
    assert.equal(launches, 1)
    assert.deepEqual(
      first.map(result => result.status),
      ['rejected', 'rejected', 'rejected']
    )

    await assert.rejects(runtime.resolveBackend(), error => error === failure)
    assert.equal(launches, 1)

    clock = 2_000
    await assert.rejects(runtime.resolveBackend(), error => error === failure)
    assert.equal(launches, 2)
  })
}

test('deterministic enrollment rejection terminates boot progress and a later refresh can recover', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-rejected-enrollment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)

  const updates = []
  let outcome = 'reject'
  let launches = 0
  const rejection = new EvaBrokerError(
    'Electric Sheep request failed (403). [code: feature_not_enabled]',
    403,
    'feature_not_enabled'
  )
  const enrollment = {
    schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
    customerId: 'customer-one',
    runtime: 'hermes',
    agentId: 'main',
    baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
    token: 'fresh-runtime-token',
    expiresAt: FUTURE
  }
  const runtime = makeManagedRuntime(statePath, {
    updateBootProgress: update => updates.push(update),
    launchRuntime: async () => {
      launches += 1
      if (outcome === 'reject') throw rejection
      return enrollment
    }
  })

  await assert.rejects(runtime.resolveBackend(), error => error === rejection)
  assert.deepEqual(updates.at(-1), {
    error: rejection.message,
    message: rejection.message,
    phase: 'eva.enroll.error',
    progress: 100,
    running: false
  })
  assert.equal(launches, 1)

  await assert.rejects(runtime.resolveBackend(), error => error === rejection)
  assert.equal(launches, 1)

  outcome = 'success'
  await runtime.refresh()
  assert.equal(launches, 2)
  assert.equal(runtime.status().runtimeSessionActive, true)
})

test('explicit refresh bypasses cooldown once, coalesces callers, and success resets backoff', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-refresh-backoff-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)

  let clock = 0
  let launches = 0
  let releaseLaunch
  let outcome = 'fail'
  const failure = new EvaBrokerError('Runtime enrollment is temporarily unavailable.', 500, 'vm_lookup_failed')
  const enrollment = {
    schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
    customerId: 'customer-one',
    runtime: 'hermes',
    agentId: 'main',
    baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
    token: 'fresh-runtime-token',
    expiresAt: FUTURE
  }
  const runtime = makeManagedRuntime(statePath, {
    now: () => clock,
    launchRuntime: async () => {
      launches += 1
      if (outcome === 'wait') {
        await new Promise(resolve => {
          releaseLaunch = resolve
        })
      }
      if (outcome === 'fail') throw failure
      return enrollment
    }
  })

  await assert.rejects(runtime.resolveBackend(), error => error === failure)
  assert.equal(launches, 1)

  outcome = 'wait'
  const refreshOne = runtime.refresh()
  const refreshTwo = runtime.refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(launches, 2)
  outcome = 'success'
  releaseLaunch()
  await Promise.all([refreshOne, refreshTwo])
  assert.equal(launches, 2)

  outcome = 'fail'
  await assert.rejects(runtime.refresh(), error => error === failure)
  assert.equal(launches, 3)
  await runtime.resolveBackend()
  assert.equal(launches, 3)

  clock = 2_000
  await runtime.resolveBackend()
  assert.equal(launches, 3)
  outcome = 'success'
  await runtime.refresh()
  assert.equal(launches, 4)
})

test('forced refresh supersedes an automatic enrollment without reusing its stale promise', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-force-generation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)

  const releases = []
  let launches = 0
  const runtime = makeManagedRuntime(statePath, {
    launchRuntime: async () => {
      launches += 1
      const index = launches
      await new Promise(resolve => releases.push(resolve))
      return {
        schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
        customerId: 'customer-one',
        runtime: 'hermes',
        agentId: 'main',
        baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
        token: index === 1 ? 'stale-runtime-token' : 'forced-runtime-token',
        expiresAt: FUTURE
      }
    }
  })

  const automatic = runtime.resolveBackend()
  await new Promise(resolve => setImmediate(resolve))
  const forced = runtime.refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(launches, 2)

  releases[1]()
  await forced
  releases[0]()
  await assert.rejects(
    automatic,
    error => error instanceof EvaBrokerError && error.code === 'stale-auth'
  )

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.runtime.token, 'forced-runtime-token')
})

test('failed forced refresh preserves the last-known-good runtime atomically', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-atomic-refresh-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  const failure = new EvaBrokerError('Runtime enrollment is temporarily unavailable.', 500, 'vm_lookup_failed')
  const runtime = makeManagedRuntime(statePath, {
    launchRuntime: async () => {
      throw failure
    }
  })

  await assert.rejects(runtime.refresh(), error => error === failure)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.runtime.token, 'runtime-token')
  assert.equal(runtime.status().runtimeSessionActive, true)
})

test('refresh preserves renderer state while reconnecting the same customer and agent assignment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-refresh-same-assignment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  let connectionResets = 0
  let rendererResets = 0
  const runtime = makeManagedRuntime(statePath, {
    launchRuntime: async () => ({
      schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
      customerId: 'customer-one',
      runtime: 'hermes',
      agentId: 'main',
      baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
      token: 'refreshed-runtime-token',
      expiresAt: FUTURE
    }),
    resetConnection: () => {
      connectionResets += 1
    },
    resetRenderer: async () => {
      rendererResets += 1
    }
  })

  await runtime.refresh()

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.runtime.token, 'refreshed-runtime-token')
  assert.equal(connectionResets, 1)
  assert.equal(rendererResets, 0)
})

test('refresh resets renderer state when either assignment identity changes', async t => {
  for (const assignment of [
    { customerId: 'customer-two', agentId: 'main' },
    { customerId: 'customer-one', agentId: 'secondary' }
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-refresh-new-assignment-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const statePath = path.join(directory, 'eva-enrollment.json')
    writeActiveEnrollment(statePath)

    let connectionResets = 0
    let rendererResets = 0
    const runtime = makeManagedRuntime(statePath, {
      launchRuntime: async () => ({
        schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
        customerId: assignment.customerId,
        runtime: 'hermes',
        agentId: assignment.agentId,
        baseUrl: `https://hermes-${assignment.customerId}.ecs.electricsheephq.com`,
        token: 'new-assignment-runtime-token',
        expiresAt: FUTURE
      }),
      resetConnection: () => {
        connectionResets += 1
      },
      resetRenderer: async () => {
        rendererResets += 1
      }
    })

    await runtime.refresh()

    assert.equal(connectionResets, 1)
    assert.equal(rendererResets, 1)
  }
})

test('production reauthentication errors trigger one runtime re-enrollment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-production-401-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  let waits = 0
  let launches = 0
  const runtime = makeManagedRuntime(statePath, {
    waitForHermes: async () => {
      waits += 1
      if (waits === 1) {
        throw Object.assign(new Error('The remote session needs authentication.'), { isReauthRequired: true })
      }
    },
    launchRuntime: async () => {
      launches += 1
      return {
        schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
        customerId: 'customer-one',
        runtime: 'hermes',
        agentId: 'main',
        baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
        token: 'refreshed-runtime-token',
        expiresAt: FUTURE
      }
    }
  })

  await runtime.resolveBackend()
  assert.equal(waits, 2)
  assert.equal(launches, 1)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.runtime.token, 'refreshed-runtime-token')
})

test('PKCE sign-in keeps one verifier per attempt, rejects wrong callbacks, and clears attempt secrets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-pkce-lifecycle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')

  const issuedVerifiers = ['A'.repeat(43), 'B'.repeat(43)]
  const opened = []
  const polls = []
  let releaseFirstPoll
  const firstPollGate = new Promise(resolve => {
    releaseFirstPoll = resolve
  })
  const desktop = {
    token: 'desktop-session-token',
    expiresAt: FUTURE,
    email: 'employee@example.invalid'
  }
  const enrollment = {
    schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
    customerId: 'customer-one',
    runtime: 'hermes',
    agentId: 'main',
    baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
    token: 'runtime-session-token',
    expiresAt: FUTURE
  }
  const runtime = makeManagedRuntime(statePath, {
    makeCodeVerifier: () => issuedVerifiers.shift(),
    codeChallengeFor: evaDesktopCodeChallenge,
    openExternal: async url => {
      opened.push(new URL(url))
    },
    pollDeviceCode: async (deviceCode, verifier, options) => {
      polls.push({ deviceCode, verifier, signal: options.signal })
      if (polls.length === 1) await firstPollGate
      return desktop
    },
    launchRuntime: async () => enrollment,
    revokeDesktopSession: async () => true
  })

  const firstSignIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  const firstUrl = opened[0]
  const firstState = firstUrl.searchParams.get('desktop_auth_state')
  const firstVerifier = 'A'.repeat(43)
  assert.equal(firstUrl.searchParams.get('desktop_code_challenge'), evaDesktopCodeChallenge(firstVerifier))
  assert.equal(firstUrl.searchParams.get('desktop_code_challenge_method'), 'S256')
  assert.equal(firstUrl.toString().includes(firstVerifier), false)

  await assert.rejects(
    runtime.completeCallback(
      `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${firstState}-wrong`
    ),
    error => error instanceof EvaBrokerError && error.code === 'state-mismatch'
  )
  await assert.rejects(
    runtime.completeCallback(
      `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${firstState}&desktop_session=leaked`
    ),
    error => error instanceof EvaBrokerError && error.code === 'invalid-callback'
  )
  assert.equal(
    await runtime.completeCallback(
      `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${firstState}`
    ),
    true
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    polls.map(({ deviceCode, verifier }) => ({ deviceCode, verifier })),
    [{ deviceCode: 'ABCDEFGH', verifier: firstVerifier }]
  )
  await assert.rejects(
    runtime.completeCallback(
      `evaos-agent://auth/callback?device_code=IJKLMNOP&desktop_auth_state=${firstState}`
    ),
    error => error instanceof EvaBrokerError && error.code === 'device-code-mismatch'
  )

  releaseFirstPoll()
  await firstSignIn
  assert.equal(await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${firstState}`
  ), false)
  const persistedAfterSuccess = fs.readFileSync(statePath, 'utf8')
  for (const secret of [firstVerifier, firstState, 'ABCDEFGH']) {
    assert.equal(persistedAfterSuccess.includes(secret), false)
  }

  const secondSignIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  const secondUrl = opened[1]
  const secondState = secondUrl.searchParams.get('desktop_auth_state')
  const secondVerifier = 'B'.repeat(43)
  assert.equal(secondUrl.searchParams.get('desktop_code_challenge'), evaDesktopCodeChallenge(secondVerifier))
  assert.notEqual(
    secondUrl.searchParams.get('desktop_code_challenge'),
    firstUrl.searchParams.get('desktop_code_challenge')
  )
  assert.notEqual(secondState, firstState)
  assert.equal(secondUrl.toString().includes(secondVerifier), false)

  await runtime.signOut()
  await assert.rejects(
    secondSignIn,
    error => error instanceof EvaBrokerError && error.code === 'stale-auth'
  )
  assert.equal(
    await runtime.completeCallback(
      `evaos-agent://auth/callback?device_code=QRSTUVWX&desktop_auth_state=${secondState}`
    ),
    false
  )
  const persistedAfterSignOut = fs.readFileSync(statePath, 'utf8')
  for (const secret of [secondVerifier, secondState, 'QRSTUVWX']) {
    assert.equal(persistedAfterSignOut.includes(secret), false)
  }
  assert.equal(issuedVerifiers.length, 0)
})

test('post-login support selection claims with the new employee session before any own-runtime launch', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-sign-in-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  const requestId = '00000000-0000-4000-8000-000000000099'
  let opened
  let releaseClaim
  let ownLaunches = 0
  let rendererResets = 0
  const clock = Date.now()
  const activation = new Date(clock + 2_000).toISOString()
  const deadline = new Date(clock + 3_602_000).toISOString()
  const claimGate = new Promise(resolve => { releaseClaim = resolve })
  const runtime = makeManagedRuntime(statePath, {
    now: () => clock,
    resetRenderer: async () => { rendererResets += 1; return true },
    openExternal: async url => { opened = new URL(url) },
    pollDeviceCode: async () => ({ token: 'new-employee-session', expiresAt: FUTURE, email: 'employee@example.invalid', supportRequestId: requestId }),
    launchRuntime: async () => { ownLaunches += 1; throw new Error('wrong workspace') },
    brokerPost: async (body, options) => {
      assert.equal(body.action, 'claim_internal_support_request')
      assert.equal(body.request_id, requestId)
      assert.equal(options.desktopSession, 'new-employee-session')
      await claimGate
      return supportEnrollment(clock, { activated_at: activation, support_expires_at: deadline })
    }
  })
  t.after(() => runtime.close())
  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(opened.searchParams.get('desktop_support_login_version'), '1')
  await runtime.completeCallback(`evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`)
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(runtime.resolveBackend(), error => error.code === 'support-sign-in-pending')
  assert.equal(ownLaunches, 0)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).support_sign_in_pending, true)
  const restarted = makeManagedRuntime(statePath, {
    launchRuntime: async () => { ownLaunches += 1; throw new Error('wrong workspace after restart') }
  })
  await assert.rejects(restarted.resolveBackend(), error => error.code === 'support-sign-in-pending')
  restarted.close()
  releaseClaim()
  const status = await signingIn
  assert.equal(status.delegatedSupportActive, true)
  assert.equal(status.supportExpiresAt, deadline)
  const persisted = JSON.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support.enrollment)
  assert.equal(persisted.activated_at, activation)
  assert.equal(persisted.support_expires_at, deadline)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).support_sign_in_pending, undefined)
  assert.equal(rendererResets, 1)
  assert.equal(status.email, 'employee@example.invalid')
  assert.equal((await runtime.resolveBackend({ profile: 'support' })).profile, 'support')
  await assert.rejects(runtime.resolveBackend({ profile: 'other' }), error => error.code === 'support-profile-mismatch')
  await assert.rejects(runtime.signIn(), error => error.code === 'support-session-active')
  assert.equal(fs.readFileSync(statePath, 'utf8').includes(requestId), false)
  assert.equal(ownLaunches, 0)
})

test('a rejected support enrollment logs its safe stage and exposes sign-in recovery after cleanup', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let opened
  let boot
  const logs = []
  const runtime = makeManagedRuntime(path.join(directory, 'state.json'), {
    openExternal: async url => { opened = new URL(url) },
    pollDeviceCode: async () => ({ token: 'private-desktop-token', expiresAt: FUTURE, email: 'employee@example.invalid', supportRequestId: '00000000-0000-4000-8000-000000000099' }),
    revokeDesktopSession: async () => true,
    brokerPost: async () => supportEnrollment(Date.now(), { support_expires_at: new Date(Date.now() + 7_200_000).toISOString() }),
    rememberLog: line => logs.push(line),
    updateBootProgress: value => { boot = value }
  })
  t.after(() => runtime.close())
  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(`evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`)
  await assert.rejects(signingIn, error => error.code === 'invalid-support-session')
  await assert.rejects(runtime.resolveBackend(), error => error.code === 'sign-in-required')
  assert.equal(boot.phase, 'eva.sign-in-required')
  assert.match(boot.error, /unsafe support deadline/)
  assert.match(logs.join('\n'), /support-claim failed:.*unsafe support deadline/)
  assert.equal(logs.join('\n').includes('private-desktop-token'), false)
})

test('sign-in recovery distinguishes real early failures from clean sign-out', async t => {
  for (const stage of ['browser-sign-in', 'device-code-claim']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-early-sign-in-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    let opened
    let boot
    const logs = []
    const runtime = makeManagedRuntime(path.join(directory, 'state.json'), {
      openExternal: async url => {
        opened = new URL(url)
        if (stage === 'browser-sign-in') throw new Error('private-browser-context')
      },
      pollDeviceCode: async () => { throw new EvaBrokerError('Sign-in service timed out.', 408, 'timeout') },
      rememberLog: line => logs.push(line),
      updateBootProgress: value => { boot = value }
    })
    t.after(() => runtime.close())
    await assert.rejects(runtime.resolveBackend(), error => error.code === 'sign-in-required')
    assert.equal(boot.error, null)
    const signingIn = runtime.signIn()
    const rejection = assert.rejects(signingIn)
    if (stage === 'device-code-claim') {
      await new Promise(resolve => setImmediate(resolve))
      await runtime.completeCallback(`evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`)
    }
    await rejection
    await assert.rejects(runtime.resolveBackend(), error => error.code === 'sign-in-required')
    assert.equal(boot.error, stage === 'browser-sign-in' ? 'evaOS Agent sign-in could not be completed.' : 'Sign-in service timed out.')
    assert.ok(logs.some(line => line.includes(`${stage} failed:`)))
    assert.equal(logs.join('\n').includes('private-browser-context'), false)
    await runtime.signOut()
    await assert.rejects(runtime.resolveBackend(), error => error.code === 'sign-in-required')
    assert.equal(boot.error, null)
  }
})

for (const expired of [false, true]) test(`interrupted support sign-in recovers through visible Sign In (expired=${expired})`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-sign-in-interrupted-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.support_sign_in_pending = true
  if (expired) state.desktop.expires_at = '2020-01-01T00:00:00.000Z'
  fs.writeFileSync(statePath, JSON.stringify(state))
  const revoked = []
  let launches = 0
  let opened = 0
  const runtime = makeManagedRuntime(statePath, {
    revokeDesktopSession: async token => { revoked.push(token); return true },
    openExternal: async () => { opened += 1 },
    launchRuntime: async () => { launches += 1; throw new Error('must not launch') }
  })
  t.after(() => runtime.close())
  await assert.rejects(runtime.resolveBackend(), error => error.code === 'support-sign-in-pending')
  const signingIn = runtime.signIn()
  const cancelled = assert.rejects(signingIn, error => error.code === 'stale-auth')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(opened, 1)
  assert.equal(launches, 0)
  assert.equal(revoked.length, expired ? 0 : 1)
  assert.equal(fs.existsSync(statePath), false)
  assert.equal(runtime.status().desktopSessionActive, false)
  await runtime.signOut()
  await cancelled
})

test('a failed selected support claim revokes the new employee session without own-workspace fallback', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-sign-in-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  let opened
  const revoked = []
  const runtime = makeManagedRuntime(statePath, {
    openExternal: async url => { opened = new URL(url) },
    pollDeviceCode: async () => ({ token: 'new-employee-session', expiresAt: FUTURE, email: 'employee@example.invalid', supportRequestId: '00000000-0000-4000-8000-000000000099' }),
    launchRuntime: async () => { throw new Error('must not launch another workspace') },
    brokerPost: async () => { throw new EvaBrokerError('Expired support request', 403, 'support-expired') },
    revokeDesktopSession: async token => { revoked.push(token); return true }
  })
  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(`evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`)
  await assert.rejects(signingIn, error => error.code === 'support-expired')
  assert.deepEqual(revoked, ['new-employee-session'])
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(fs.readFileSync(statePath, 'utf8').includes('new-employee-session'), false)
})

test('managed sign-in checks callback ownership before clearing the existing enrollment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-callback-preflight-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let opened = 0
  const runtime = makeManagedRuntime(statePath, {
    ensureSignInCallbackReady: async () => {
      throw Object.assign(new Error('wrong handler'), { code: 'callback-handler-mismatch' })
    },
    openExternal: async () => {
      opened += 1
    }
  })

  await assert.rejects(
    runtime.signIn(),
    error => error instanceof EvaBrokerError && error.statusCode === 503 && error.code === 'callback-handler-mismatch'
  )
  assert.equal(opened, 0)
  assert.equal(runtime.status().email, 'employee@example.invalid')
  assert.equal(runtime.status().agentDisplayName, 'Asuka')
})

test('an expired PKCE claim clears its callback state and verifier', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-pkce-expiry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  const verifier = 'C'.repeat(43)
  let opened
  const timeout = new EvaBrokerError('evaOS Agent sign-in timed out.', 408, 'timeout')
  const runtime = makeManagedRuntime(statePath, {
    makeCodeVerifier: () => verifier,
    codeChallengeFor: evaDesktopCodeChallenge,
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => {
      throw timeout
    }
  })

  const signIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  const state = opened.searchParams.get('desktop_auth_state')
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${state}`
  )
  await assert.rejects(signIn, error => error === timeout)
  assert.equal(
    await runtime.completeCallback(
      `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${state}`
    ),
    false
  )
  assert.equal(fs.existsSync(statePath), false)
  assert.equal(opened.toString().includes(verifier), false)
})

test('managed sign-in times out while waiting for an ignored browser callback and can retry', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-callback-timeout-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  let opened = 0
  const runtime = makeManagedRuntime(statePath, {
    loginTimeoutMs: 5,
    openExternal: async () => {
      opened += 1
    }
  })

  await assert.rejects(
    runtime.signIn(),
    error => error instanceof EvaBrokerError && error.statusCode === 408 && error.code === 'timeout'
  )
  await assert.rejects(
    runtime.signIn(),
    error => error instanceof EvaBrokerError && error.statusCode === 408 && error.code === 'timeout'
  )

  assert.equal(opened, 2)
  assert.equal(fs.existsSync(statePath), false)
})

test('a stale in-flight launch cannot restore backoff after auth invalidation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-stale-backoff-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)

  let launches = 0
  let rejectLaunch
  let outcome = 'wait'
  const failure = new EvaBrokerError('Runtime enrollment is temporarily unavailable.', 500, 'vm_lookup_failed')
  const enrollment = {
    schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
    customerId: 'customer-one',
    runtime: 'hermes',
    agentId: 'main',
    baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
    token: 'fresh-runtime-token',
    expiresAt: FUTURE
  }
  const runtime = makeManagedRuntime(statePath, {
    now: () => 0,
    launchRuntime: async () => {
      launches += 1
      if (outcome === 'wait') {
        await new Promise((_resolve, reject) => {
          rejectLaunch = reject
        })
      }
      return enrollment
    }
  })

  const staleLaunch = runtime.resolveBackend()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.close()
  outcome = 'success'
  rejectLaunch(failure)

  await assert.rejects(staleLaunch, error => error instanceof EvaBrokerError && error.code === 'stale-auth')
  const backend = await runtime.resolveBackend()
  assert.equal(launches, 2)
  assert.equal(backend.baseUrl, 'eva-managed://customer-one')
})

test('closing the runtime drops the cached relay before a later reconnect', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-relay-reopen-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  let relays = 0
  const closed = []
  const runtime = makeManagedRuntime(statePath, {
    createWsRelay: () => {
      const id = ++relays
      return {
        mintTicket: async () => `ws://127.0.0.1:${12_000 + id}/managed`,
        disconnectAll: () => undefined,
        close: async () => closed.push(id)
      }
    }
  })

  const first = await runtime.resolveBackend()
  await runtime.close()
  const second = await runtime.resolveBackend()

  assert.equal(relays, 2)
  assert.deepEqual(closed, [1])
  assert.notEqual(first.wsUrl, second.wsUrl)
})

test('managed media keeps Range and runtime credentials in the main-process fetch seam', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-media-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  const calls = []
  const response = { status: 206 }
  const runtime = makeManagedRuntime(statePath, {
    fetchMedia: async (url, token, headers) => {
      calls.push({ headers, token, url })
      return response
    }
  })

  const result = await runtime.requestMedia({
    headers: { range: 'bytes=100-199' },
    path: '/api/files/download?path=%2Fsrv%2Frender.mp4',
    profile: 'research'
  })

  assert.equal(result, response)
  assert.deepEqual(calls, [
    {
      headers: { range: 'bytes=100-199' },
      token: 'runtime-token',
      url: 'https://hermes-customer-one.ecs.electricsheephq.com/api/files/download?path=%2Fsrv%2Frender.mp4&profile=research'
    }
  ])
})

test('a runtime 401 clears older transient backoff before requiring sign-in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-sign-in-backoff-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)

  let launches = 0
  let outcome = 'fail'
  const failure = new EvaBrokerError('Runtime enrollment is temporarily unavailable.', 500, 'vm_lookup_failed')
  const runtime = makeManagedRuntime(statePath, {
    now: () => 0,
    launchRuntime: async () => {
      launches += 1
      if (outcome === 'unauthorized') {
        throw new EvaBrokerError('Desktop session was revoked.', 401, 'unauthorized')
      }
      throw failure
    }
  })

  await assert.rejects(runtime.resolveBackend(), error => error === failure)
  outcome = 'unauthorized'
  await assert.rejects(runtime.refresh(), error => error instanceof EvaBrokerError && error.code === 'sign-in-required')
  await assert.rejects(
    runtime.resolveBackend(),
    error => error instanceof EvaBrokerError && error.code === 'sign-in-required'
  )
  assert.equal(launches, 2)
})

test('managed runtime forwards unknown APIs, bodies, uploads, and Hermes profiles to the assigned backend', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-passthrough-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  const calls = []
  const runtime = createEvaManagedRuntime({
    statePath,
    encryptSecret: value => value,
    decryptSecret: value => value,
    fetchJson: async (url, token, options) => {
      calls.push({ url, token, options })
      return { ok: true }
    },
    createWsRelay: () => ({
      mintTicket: async () => 'ws://127.0.0.1:12345/managed',
      disconnectAll: () => undefined,
      close: async () => undefined
    }),
    resolveTimeoutMs: () => 1_000
  })

  const upload = {
    filename: 'future.bin',
    contentType: 'application/octet-stream',
    bytes: Buffer.from([1, 2, 3])
  }
  await runtime.requestApi({
    path: '/api/future-feature?mode=alpha',
    method: 'POST',
    profile: 'research',
    body: { future: true },
    upload
  })

  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    'https://hermes-customer-one.ecs.electricsheephq.com/api/future-feature?mode=alpha&profile=research'
  )
  assert.equal(calls[0].token, 'runtime-token')
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(calls[0].options.body, { future: true })
  assert.equal(calls[0].options.upload, upload)
})

test('ordinary managed all-profile lists retain the concrete routing profile', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-ordinary-list-scope-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const calls = []
  const runtime = makeManagedRuntime(statePath, {
    fetchJson: async url => {
      calls.push(url)
      return { sessions: [] }
    }
  })

  await runtime.requestApi({
    path: '/api/profiles/sessions?limit=40&offset=0&profile=all',
    profile: 'research'
  })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0])
  assert.equal(url.pathname, '/api/profiles/sessions')
  assert.equal(url.searchParams.get('profile'), 'research')
  assert.equal(url.searchParams.get('limit'), '40')
  assert.equal(url.searchParams.get('offset'), '0')
  await assert.rejects(runtime.requestApi({
    path: '/api/profiles/sessions?profile=all&profile=other',
    profile: 'research'
  }), error => error.code === 'managed-policy')
  assert.equal(calls.length, 1)
})

test('ordinary managed request failures preserve their original error', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-ordinary-error-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  const failure = new Error('ordinary backend unavailable')
  const runtime = createEvaManagedRuntime({
    statePath,
    encryptSecret: value => value,
    decryptSecret: value => value,
    fetchJson: async () => {
      throw failure
    },
    createWsRelay: () => ({
      mintTicket: async () => 'ws://127.0.0.1:12345/managed',
      disconnectAll: () => undefined,
      close: async () => undefined
    }),
    resolveTimeoutMs: () => 1_000
  })

  await assert.rejects(runtime.requestApi({ path: '/api/sessions', method: 'GET' }), error => error === failure)
})

test('managed connections and endpoint tickets preserve the selected profile and runtime generation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-runtime-ws-profile-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)

  let relayOptions
  const minted = []
  const runtime = makeManagedRuntime(statePath, {
    createWsRelay: options => {
      relayOptions = options
      return {
        mintTicket: async request => {
          minted.push(request)
          return `ws://127.0.0.1:12345${request.path}?ticket=fresh`
        },
        disconnectAll: () => undefined,
        close: async () => undefined
      }
    }
  })
  t.after(async () => runtime.close())

  const connection = await runtime.resolveBackend({ profile: 'research' })
  assert.equal(connection.profile, 'research')
  assert.equal(connection.token, '')
  assert.deepEqual(minted[0], {
    generation: 0,
    path: '/api/ws',
    profile: 'research'
  })

  await runtime.freshWsUrl({
    path: '/api/plugins/kanban/events?mode=live',
    profile: 'research'
  })
  assert.deepEqual(minted[1], {
    generation: 0,
    path: '/api/plugins/kanban/events?mode=live',
    profile: 'research'
  })

  const upstream = await relayOptions.getUpstream()
  assert.equal(upstream.baseUrl, 'https://hermes-customer-one.ecs.electricsheephq.com')
  assert.equal(upstream.token, 'runtime-token')
  assert.equal(upstream.generation, minted[1].generation)
  assert.equal(relayOptions.getGeneration(), minted[1].generation)
})

test('broker requests time out instead of leaving managed launch unresolved', async () => {
  const policy = {
    brokerUrl: 'https://broker.example.invalid/runtime',
    brokerRequestTimeoutMs: 5
  }

  await assert.rejects(
    brokerPost(
      { action: 'runtime_launch' },
      {
        policy,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true }
            )
          })
      }
    ),
    error => error instanceof EvaBrokerError && error.statusCode === 408 && error.code === 'timeout'
  )
})

// ── adapter#91 / sc#540 — the own-workspace 403 dead end ────────────────────
// An internal admin owns no agent, so `runtime_launch` is rejected by design
// forever. The installed build answered that by re-throwing the raw broker code
// at every caller: 345 identical lines in one day and no route out.

function missingAgentBindingError() {
  return new EvaBrokerError(
    'Electric Sheep request failed (403). [code: missing_hermes_agent_binding]',
    403,
    'missing_hermes_agent_binding'
  )
}

test('the first own-workspace 403 latches one terminal state and logs one line per state change', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-missing-agent-binding-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)
  let clock = Date.parse('2026-09-07T10:00:00.000Z')
  let launches = 0
  const logs = []
  const runtime = makeManagedRuntime(statePath, {
    now: () => clock,
    rememberLog: line => logs.push(line),
    launchRuntime: async () => {
      launches += 1
      throw missingAgentBindingError()
    }
  })
  t.after(() => runtime.close())

  // A missing capability, not a transient failure: the very first rejection
  // publishes the actionable message and the state the banner renders from.
  await assert.rejects(
    runtime.resolveBackend(),
    error =>
      error.statusCode === 403 &&
      error.code === 'missing_hermes_agent_binding' &&
      error.message === 'No personal agent for this account — use Switch support target to open a customer agent.'
  )
  assert.equal(launches, 1)
  assert.equal(runtime.status().missingAgentBinding, true)

  // Terminal: a day of polling adds no broker traffic and no new log lines, and
  // every caller receives the actionable message instead of the raw code.
  clock += 24 * 60 * 60 * 1_000
  await assert.rejects(
    runtime.resolveBackend(),
    error =>
      error.code === 'missing_hermes_agent_binding' &&
      error.message === 'No personal agent for this account — use Switch support target to open a customer agent.'
  )
  assert.equal(launches, 1)
  assert.equal(logs.filter(line => line.includes('no personal agent for this account')).length, 1)
})

test('a binding created while the app is running recovers on the next forced launch', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-missing-agent-binding-recovery-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)
  let launches = 0
  const logs = []
  const runtime = makeManagedRuntime(statePath, {
    rememberLog: line => logs.push(line),
    launchRuntime: async () => {
      launches += 1
      if (launches < 2) throw missingAgentBindingError()
      return {
        agentDisplayName: 'Asuka',
        agentId: 'main',
        baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
        customerId: 'customer-one',
        expiresAt: FUTURE,
        runtime: 'hermes',
        schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
        token: 'fresh-runtime-token'
      }
    }
  })
  t.after(() => runtime.close())

  await assert.rejects(runtime.resolveBackend(), error => error.code === 'missing_hermes_agent_binding')
  assert.equal(runtime.status().missingAgentBinding, true)

  // The operator action the banner and the boot overlay both drive: a forced
  // re-enrollment. The latch is not sticky against a binding that now exists.
  await runtime.refresh()

  assert.equal(runtime.status().agentId, 'main')
  assert.equal(runtime.status().runtimeSessionActive, true)
  assert.equal(runtime.status().missingAgentBinding, false)
  assert.equal(logs.filter(line => line.includes('cleared the no-personal-agent state')).length, 1)
})

// In-app support target picker (sc#540): the switch never signs out, the
// picker lists and creates over the desktop session, and the lease handle is
// on disk before the claim and preserved through every failure that can strand
// the server-side row.
const SUPPORT_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555'
const SUPPORT_VM_ID = '66666666-7777-4888-9999-000000000000'
const SUPPORT_REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SUPPORT_SESSION_ID = 'ffffffff-0000-4111-8222-333333333333'

function supportTarget(overrides = {}) {
  return {
    customer_account_id: SUPPORT_ACCOUNT_ID,
    customer_vm_id: SUPPORT_VM_ID,
    profile_id: 'main',
    acknowledged: true,
    customer_label: 'Acme',
    agent_label: 'Asuka',
    ...overrides
  }
}

function supportRequestCreated() {
  return {
    ok: true,
    request_id: SUPPORT_REQUEST_ID,
    support_session_id: SUPPORT_SESSION_ID,
    request_expires_at: new Date(Date.now() + 2 * 60 * 1_000).toISOString()
  }
}

function brokerRejection(status, code) {
  const error = new EvaBrokerError(`Electric Sheep request failed (${status}). [code: ${code}]`, status, code)
  error.brokerRejected = true
  return error
}

// Raw on-disk handles: the list, or the singular pre-list key as one element.
function persistedSupportLeases(statePath) {
  try {
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    return persisted.support_leases ?? (persisted.support_lease ? [persisted.support_lease] : [])
  } catch {
    return []
  }
}

function persistedSupportLease(statePath) {
  return persistedSupportLeases(statePath)[0] ?? null
}

test('a plain sign-in that never reaches the browser keeps the no-personal-agent state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-switch-support-target-handoff-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)
  let revoked = 0
  const runtime = makeManagedRuntime(statePath, {
    openExternal: async () => {
      throw new Error('no browser')
    },
    revokeDesktopSession: async () => {
      revoked += 1
      return true
    },
    launchRuntime: async () => {
      throw missingAgentBindingError()
    }
  })
  t.after(() => runtime.close())

  await assert.rejects(runtime.resolveBackend(), error => error.code === 'missing_hermes_agent_binding')
  assert.equal(runtime.status().missingAgentBinding, true)

  // The picker reported the broker rejected the session it has, so a fresh
  // plain sign-in is forced. A handoff that never completes must not leave the
  // operator with no banner and no route back.
  await assert.rejects(runtime.switchSupportTarget({ signInAgain: true }))

  assert.equal(runtime.status().missingAgentBinding, true)
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(revoked, 0)
})

test('switching the support target with a live session opens no browser and keeps the lease', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-switch-support-target-live-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const actions = []
  let opened = 0
  let revoked = 0
  const runtime = makeManagedRuntime(statePath, {
    openExternal: async () => {
      opened += 1
    },
    revokeDesktopSession: async () => {
      revoked += 1
      return true
    },
    brokerPost: async body => {
      actions.push(body.action)
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  await runtime.claimSupportRequest('request-123')
  const status = await runtime.switchSupportTarget()

  // No sign-out, no end, no browser: the picker runs on the session in hand and
  // the active lease is only ended once a new target is actually chosen.
  assert.equal(opened, 0)
  assert.equal(revoked, 0)
  assert.deepEqual(actions, ['claim_internal_support_request'])
  assert.equal(status.supportPickerAvailable, true)
  assert.equal(status.delegatedSupportActive, true)
  assert.equal(runtime.status().delegatedSupportActive, true)
})

test('switching the support target without a session requests a plain sign-in and keeps the no-agent latch', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-switch-support-target-plain-sign-in-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  const logs = []
  let opened
  let revoked = 0
  const runtime = makeManagedRuntime(statePath, {
    rememberLog: line => logs.push(line),
    openExternal: async url => {
      opened = new URL(url)
    },
    revokeDesktopSession: async () => {
      revoked += 1
      return true
    },
    pollDeviceCode: async () => ({ token: 'plain-desktop-session', expiresAt: FUTURE, email: 'employee@example.invalid' }),
    launchRuntime: async () => {
      throw missingAgentBindingError()
    }
  })
  t.after(() => runtime.close())

  const switching = runtime.switchSupportTarget()
  await new Promise(resolve => setImmediate(resolve))

  // Version 2 asks the page for a PLAIN session: no page-side picker, one
  // "Continue as" click. Account choice is still forced.
  assert.equal(opened.pathname, '/desktop-auth')
  assert.equal(opened.searchParams.get('desktop_support_login_version'), '2')
  assert.equal(opened.searchParams.get('switch_account'), '1')

  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )
  const status = await switching

  // The admin's own-workspace 403 is expected here and must not fail the
  // sign-in; it re-latches the banner under the picker instead.
  assert.equal(status.email, 'employee@example.invalid')
  assert.equal(status.desktopSessionActive, true)
  assert.equal(status.supportPickerAvailable, true)
  assert.equal(status.missingAgentBinding, true)
  assert.equal(revoked, 0)
  assert.equal(logs.some(line => line.includes('plain sign-in complete; enrollment deferred: missing_hermes_agent_binding')), true)
})

test('the in-app picker lists the directory over the desktop session and drops rows it cannot start', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-list-targets-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const calls = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async (body, options) => {
      calls.push({ body, desktopSession: options?.desktopSession })
      return {
        ok: true,
        is_admin: true,
        clients: [
          {
            customer_account_id: SUPPORT_ACCOUNT_ID,
            customer_vm_id: SUPPORT_VM_ID,
            display_name: ' Acme  Corp ',
            assignment_allowed: true,
            profiles: [{ profile_id: 'main', display_name: 'Asuka' }, { profile_id: 'bad profile!', display_name: 'x' }]
          },
          { customer_account_id: SUPPORT_ACCOUNT_ID, customer_vm_id: null, display_name: 'No VM', profiles: [{ profile_id: 'main', display_name: 'A' }] },
          { customer_account_id: SUPPORT_ACCOUNT_ID, customer_vm_id: SUPPORT_VM_ID, display_name: 'No profiles', profiles: [] },
          { customer_account_id: 'not-a-uuid', customer_vm_id: SUPPORT_VM_ID, display_name: 'Bad id', profiles: [{ profile_id: 'main', display_name: 'A' }] },
          {
            customer_account_id: SUPPORT_ACCOUNT_ID,
            customer_vm_id: SUPPORT_VM_ID,
            display_name: 'Not assignable',
            assignment_allowed: false,
            profiles: [{ profile_id: 'main', display_name: 'A' }]
          }
        ]
      }
    }
  })
  t.after(() => runtime.close())

  const result = await runtime.listSupportTargets()

  assert.deepEqual(calls, [
    { body: { action: 'list_internal_support_clients', directory_only: true }, desktopSession: 'desktop-token' }
  ])
  assert.deepEqual(result, {
    ok: true,
    is_admin: true,
    clients: [
      {
        customer_account_id: SUPPORT_ACCOUNT_ID,
        customer_vm_id: SUPPORT_VM_ID,
        display_name: 'Acme Corp',
        profiles: [{ profile_id: 'main', display_name: 'Asuka' }]
      }
    ]
  })
})

test('starting a support target persists the lease handle before the claim and keeps it beside the enrollment after', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-happy-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const calls = []
  let leaseAtClaim = null
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async (body, options) => {
      calls.push({ body, desktopSession: options?.desktopSession })
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'claim_internal_support_request') {
        leaseAtClaim = persistedSupportLease(statePath)
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const result = await runtime.startDelegatedSupport(supportTarget({ profile_id: 'main', extra: 'ignored' }))

  assert.equal(result.ok, true)
  assert.equal(result.status.delegatedSupportActive, true)
  // Same body as the dashboard picker sends, on the desktop session.
  assert.deepEqual(calls[0], {
    body: {
      action: 'create_internal_support_request',
      customer_account_id: SUPPORT_ACCOUNT_ID,
      customer_vm_id: SUPPORT_VM_ID,
      profile_id: 'main',
      acknowledged: true
    },
    desktopSession: 'desktop-token'
  })
  assert.deepEqual(calls[1].body, {
    action: 'claim_internal_support_request',
    desktop_support_profiles_version: 1,
    request_id: SUPPORT_REQUEST_ID
  })
  // The handle was on disk when the claim ran, and the enrollment owns it now.
  assert.equal(leaseAtClaim?.support_session_id, SUPPORT_SESSION_ID)
  assert.equal(leaseAtClaim?.request_id, SUPPORT_REQUEST_ID)
  assert.equal(leaseAtClaim?.phase, 'pending')
  assert.equal(leaseAtClaim?.target_label, 'Acme / Asuka')
  // The handle now lives beside the enrollment, with the server's deadline, so
  // a credential expiry that erases the enrollment cannot erase the only id.
  const active = persistedSupportLease(statePath)
  assert.equal(active?.support_session_id, SUPPORT_SESSION_ID)
  assert.equal(active?.request_id, SUPPORT_REQUEST_ID)
  assert.equal(active?.phase, 'active')
  assert.ok(Date.parse(active?.support_expires_at) > Date.now())
  assert.equal(runtime.status().delegatedSupportActive, true)
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('an all-agents target carries the customer scope and never a profile', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-all-agents-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const bodies = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      bodies.push(body)
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'claim_internal_support_request') return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const result = await runtime.startDelegatedSupport(supportTarget({ profile_id: '', profile_scope: 'customer' }))

  assert.equal(result.ok, true)
  // Customer scope omits `profile_id` entirely rather than sending it empty.
  assert.deepEqual(bodies[0], {
    action: 'create_internal_support_request',
    customer_account_id: SUPPORT_ACCOUNT_ID,
    customer_vm_id: SUPPORT_VM_ID,
    profile_scope: 'customer',
    acknowledged: true
  })
  assert.equal(Object.hasOwn(bodies[0], 'profile_id'), false)
})

test('a claim that fails after create ends the pending row with the persisted handle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-claim-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const actions = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      actions.push(body)
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'claim_internal_support_request') throw brokerRejection(403, 'delegated_support_denied')
      if (body.action === 'internal_support_session_end') return { ok: true }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const result = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'forbidden')
  assert.deepEqual(
    actions.map(body => body.action),
    ['create_internal_support_request', 'claim_internal_support_request', 'internal_support_session_end']
  )
  assert.equal(actions[2].support_session_id, SUPPORT_SESSION_ID)
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(runtime.status().desktopSessionActive, true)
})

test('a failed end after a failed claim keeps the handle and the next start retries it first', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-cleanup-retry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const actions = []
  let ends = 0
  let claims = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      actions.push(body)
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'claim_internal_support_request') {
        claims += 1
        if (claims === 1) throw brokerRejection(503, 'broker_unavailable')
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      if (body.action === 'internal_support_session_end') {
        ends += 1
        if (ends === 1) throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
        return { ok: true }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const first = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(first.ok, false)
  assert.equal(first.reason, 'error')
  assert.equal(persistedSupportLease(statePath)?.phase, 'cleanup')
  assert.equal(runtime.status().supportCleanupPending, true)
  assert.equal(runtime.status().supportTargetLabel, 'Acme / Asuka')

  const second = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(second.ok, true)
  // The stranded row is ended before a new create, with the persisted id.
  const secondRun = actions.slice(3)
  assert.deepEqual(secondRun.map(body => body.action), [
    'internal_support_session_end',
    'create_internal_support_request',
    'claim_internal_support_request'
  ])
  assert.equal(secondRun[0].support_session_id, SUPPORT_SESSION_ID)
  assert.equal(persistedSupportLease(statePath)?.phase, 'active')
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().delegatedSupportActive, true)
})

test('picker calls map broker rejections to typed states instead of throwing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-typed-results-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let next = null
  let brokerCalls = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => {
      brokerCalls += 1
      throw next
    }
  })
  t.after(() => runtime.close())

  // An undeployed broker answers the desktop session with a bare 401 exactly
  // like a dead session does; both are "sign in again".
  next = new EvaBrokerError('Electric Sheep request failed (401).', 401, 'broker-rejected')
  next.brokerRejected = true
  assert.deepEqual(await runtime.listSupportTargets(), {
    ok: false,
    reason: 'needs_sign_in',
    code: 'broker-rejected',
    message: 'Sign in to Electric Sheep again to choose a support target.'
  })
  next = brokerRejection(403, 'delegated_support_forbidden')
  assert.equal((await runtime.listSupportTargets()).reason, 'forbidden')
  // An account outside the internal membership is the same dead end.
  next = brokerRejection(403, 'internal_membership_required')
  assert.equal((await runtime.listSupportTargets()).reason, 'forbidden')
  next = brokerRejection(409, 'delegated_support_conflict')
  assert.equal((await runtime.startDelegatedSupport(supportTarget())).reason, 'conflict')
  next = brokerRejection(500, 'internal')
  const failure = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(failure.reason, 'error')
  assert.equal(failure.message, 'Electric Sheep request failed (500). [code: internal]')
  assert.equal(brokerCalls, 5)

  // Local validation never reaches the broker: consent is a literal true the
  // operator gives, and the ids must already be well-formed.
  const consent = await runtime.startDelegatedSupport(supportTarget({ acknowledged: 'yes' }))
  assert.equal(consent.reason, 'error')
  assert.equal(consent.code, 'support-acknowledgement-required')
  const malformed = await runtime.startDelegatedSupport(supportTarget({ customer_vm_id: 'vm-1' }))
  assert.equal(malformed.code, 'invalid-support-target')
  assert.equal(brokerCalls, 5)
  assert.equal(runtime.status().desktopSessionActive, true)
})

test('picker calls without a live desktop session report needs_sign_in without a broker call', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-no-session-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  let brokerCalls = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => {
      brokerCalls += 1
      throw new Error('must not be called')
    }
  })
  t.after(() => runtime.close())

  assert.equal((await runtime.listSupportTargets()).reason, 'needs_sign_in')
  assert.equal((await runtime.startDelegatedSupport(supportTarget())).reason, 'needs_sign_in')
  assert.equal(brokerCalls, 0)
  assert.equal(runtime.status().supportPickerAvailable, false)
})

test('starting a new target ends the active lease before the create', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-over-active-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const actions = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      actions.push(body)
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), body.request_id === SUPPORT_REQUEST_ID ? { support_session_id: SUPPORT_SESSION_ID } : {})
      }
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'internal_support_session_end') return { ok: true }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  await runtime.claimSupportRequest('request-123')
  const result = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(result.ok, true)
  assert.deepEqual(actions.map(body => body.action), [
    'claim_internal_support_request',
    'internal_support_session_end',
    'create_internal_support_request',
    'claim_internal_support_request'
  ])
  assert.equal(actions[1].support_session_id, 'support-session')
  assert.equal(runtime.status().delegatedSupportActive, true)
})

test('a switch whose active lease cannot be ended reports the end failure and keeps the lease', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-end-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let creates = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') throw new EvaBrokerError('unavailable', 502, 'support-end-failed')
      if (body.action === 'create_internal_support_request') {
        creates += 1
        return supportRequestCreated()
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  await runtime.claimSupportRequest('request-123')
  const result = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(result.ok, false)
  assert.equal(result.code, 'support-end-failed')
  assert.equal(creates, 0)
  assert.equal(runtime.status().delegatedSupportActive, true)
  assert.equal(runtime.status().supportEndFailed, true)
})

test('a start whose stranded-lease cleanup fails never creates a second request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-stranded-cleanup-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: 'stranded-session',
    target_label: 'Acme / Asuka',
    phase: 'cleanup',
    recorded_at: new Date().toISOString()
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  let creates = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'internal_support_session_end') throw new EvaBrokerError('unavailable', 502, 'support-end-failed')
      if (body.action === 'create_internal_support_request') {
        creates += 1
        return supportRequestCreated()
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const result = await runtime.startDelegatedSupport(supportTarget())

  // Creating here would overwrite the only handle able to end 'stranded-session';
  // the typed state carries the End control that reaches it.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cleanup_pending')
  assert.equal(result.code, 'support-cleanup-pending')
  assert.equal(creates, 0)
  assert.equal(persistedSupportLease(statePath).support_session_id, 'stranded-session')
})

test('a sign-out that races the create ends the new request instead of claiming it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-superseded-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const actions = []
  const logs = []
  let runtime
  runtime = makeManagedRuntime(statePath, {
    rememberLog: line => logs.push(line),
    brokerPost: async body => {
      actions.push(body.action)
      if (body.action === 'create_internal_support_request') {
        // The operator signs out while the broker is still answering.
        await runtime.signOut()
        return supportRequestCreated()
      }
      if (body.action === 'internal_support_session_end') return { ok: true }
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const result = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'needs_sign_in')
  // The row is ended with the handle it was persisted under, never claimed.
  assert.equal(actions.includes('claim_internal_support_request'), false)
  assert.equal(actions.filter(action => action === 'internal_support_session_end').length >= 1, true)
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(logs.some(line => line.includes('created under a superseded session')), true)
})

test('sign-out keeps the lease handle when neither the remote end nor the revoke succeeds', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-signout-keeps-lease-handle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async (body, options) => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
      }
      throw new Error(`unexpected action ${body.action}`)
    },
    revokeDesktopSession: async () => false
  })
  t.after(() => runtime.close())

  await runtime.claimSupportRequest('request-123')
  assert.deepEqual(await runtime.signOut(), { ok: true })

  // Still signed out and locally severed, but the id that can end the row
  // survives in the tombstone for the next sign-in to retry.
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(persisted.signed_out, true)
  assert.equal(persisted.desktop ?? null, null)
  assert.equal(persisted.delegated_support ?? null, null)
  assert.deepEqual(ends, [{ id: 'support-session', desktopSession: 'desktop-token' }])
  assert.equal(persisted.support_leases.length, 1)
  assert.equal(persisted.support_leases[0].support_session_id, 'support-session')
  assert.equal(persisted.support_leases[0].phase, 'cleanup')
  assert.equal(persisted.support_leases[0].target_label, 'Customer / Support agent')
  assert.equal(runtime.status().signedOut, true)
  assert.equal(runtime.status().delegatedSupportActive, false)
  // The signed-out screen of a shared install learns nothing about the previous
  // employee's support activity: the handle waits on disk for that account.
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().supportTargetLabel, null)
})

test('sign-out drops the lease handle once the revoke has ended the lease server-side', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-signout-revoke-ends-lease-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') throw new EvaBrokerError('unavailable', 503, 'broker_unavailable')
      throw new Error(`unexpected action ${body.action}`)
    },
    revokeDesktopSession: async () => true
  })
  t.after(() => runtime.close())

  await runtime.claimSupportRequest('request-123')
  assert.deepEqual(await runtime.signOut(), { ok: true })

  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
})

// The next-sign-in enrollment stub shared by the recovery tests below.
function freshRuntimeEnrollment() {
  return {
    agentDisplayName: 'Asuka',
    agentId: 'main',
    baseUrl: 'https://hermes-customer-one.ecs.electricsheephq.com',
    customerId: 'customer-one',
    expiresAt: FUTURE,
    runtime: 'hermes',
    schemaVersion: 'evaos.hermes_desktop_enrollment.v1',
    token: 'fresh-runtime-token'
  }
}

test('a sign-in after a failed sign-out retries the stranded lease with the next desktop session and drops it only once the broker ends it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-signin-retries-stranded-lease-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  const first = makeManagedRuntime(statePath, {
    brokerPost: async (body, options) => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
      }
      throw new Error(`unexpected action ${body.action}`)
    },
    revokeDesktopSession: async () => false
  })

  // Claimed on desktop session A; the sign-out reaches neither the end nor the
  // revoke, so the row is still active server-side and only the id survives.
  await first.claimSupportRequest('request-123')
  assert.deepEqual(await first.signOut(), { ok: true })
  await first.close()
  assert.deepEqual(ends, [{ id: 'support-session', desktopSession: 'desktop-token' }])
  const tombstone = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(tombstone.desktop ?? null, null)
  assert.equal(tombstone.support_leases[0].phase, 'cleanup')
  assert.ok(tombstone.support_leases[0].support_expires_at)

  // Restart, then sign in as the SAME admin: desktop session B. The broker lets
  // the same actor end its own row from any live session, so a 403 on our own
  // row proves neither termination nor expiry — the handle is kept and the end
  // is retried; only `ok` drops it.
  const logs = []
  let opened
  let endAnswer = () => {
    throw brokerRejection(403, 'delegated_support_denied')
  }
  const runtime = makeManagedRuntime(statePath, {
    rememberLog: line => logs.push(line),
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'next-desktop-session', expiresAt: FUTURE, email: 'employee@example.invalid' }),
    launchRuntime: async () => freshRuntimeEnrollment(),
    brokerPost: async (body, options) => {
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        return endAnswer()
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))

  // No credential at boot: nothing is sent and nothing is dropped — and nothing
  // about the owner's support activity is shown to whoever sees this screen.
  assert.equal(ends.length, 1)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, 'support-session')
  assert.equal(runtime.status().supportCleanupPending, false)

  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )
  await signingIn
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(ends[1], { id: 'support-session', desktopSession: 'next-desktop-session' })
  assert.equal(persistedSupportLease(statePath)?.support_session_id, 'support-session')
  assert.equal(runtime.status().supportCleanupPending, true)
  // Signed in as the owner again, the assignment label is shown once more.
  assert.equal(runtime.status().supportTargetLabel, 'Customer / Support agent')
  assert.equal(runtime.status().runtimeSessionActive, true)
  assert.equal(logs.some(line => line.includes('stranded support lease end failed; retry pending')), true)
  assert.equal(logs.some(line => line.includes('stranded support lease dropped')), false)

  // End reaches the same handle with session B; the broker's `ok` is what
  // finally drops it.
  endAnswer = () => ({ ok: true, status: 'ended' })
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  assert.deepEqual(ends[2], { id: 'support-session', desktopSession: 'next-desktop-session' })
  assert.equal(ends.length, 3)
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('a handle recorded before actors were stamped is hidden while signed out and ended by the next sign-in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-stranded-lease-actorless-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: 'evaos.eva_desktop_managed.v1',
      signed_out: true,
      support_lease: {
        support_session_id: 'legacy-session',
        target_label: 'Acme / Asuka',
        phase: 'cleanup',
        recorded_at: new Date().toISOString()
      }
    })
  )
  const ends = []
  let opened
  const runtime = makeManagedRuntime(statePath, {
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'next-desktop-session', expiresAt: FUTURE, email: 'employee@example.invalid' }),
    launchRuntime: async () => freshRuntimeEnrollment(),
    brokerPost: async (body, options) => {
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))

  // Whoever sees the signed-out screen of this installation learns nothing
  // about the support target the handle names; the handle itself is kept.
  assert.deepEqual(ends, [])
  assert.equal(persistedSupportLease(statePath)?.support_session_id, 'legacy-session')
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().supportTargetLabel, null)

  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )
  await signingIn
  await new Promise(resolve => setImmediate(resolve))

  // The first account to sign in owns the pre-actor handle and ends the row.
  assert.deepEqual(ends, [{ id: 'legacy-session', desktopSession: 'next-desktop-session' }])
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('only a broker answer that the row no longer exists drops a stranded handle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-stranded-lease-definitive-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: SUPPORT_SESSION_ID,
    target_label: 'Acme / Asuka',
    phase: 'cleanup',
    recorded_at: new Date().toISOString()
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  const answers = [
    () => {
      throw brokerRejection(403, 'delegated_support_denied')
    },
    () => {
      throw brokerRejection(409, 'delegated_support_conflict')
    },
    () => {
      throw brokerRejection(404, 'delegated_support_not_found')
    }
  ]
  const ends = []
  const logs = []
  const runtime = makeManagedRuntime(statePath, {
    rememberLog: line => logs.push(line),
    brokerPost: async body => {
      if (body.action === 'internal_support_session_end') {
        ends.push(body.support_session_id)
        return answers.shift()()
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))

  // 403 and 409 say nothing about whether OUR row still exists: kept, retried.
  assert.deepEqual(ends, [SUPPORT_SESSION_ID])
  assert.equal(persistedSupportLease(statePath)?.support_session_id, SUPPORT_SESSION_ID)
  assert.deepEqual(await runtime.endSupportSession(), { ok: false })
  assert.equal(runtime.status().supportEndFailed, true)
  assert.equal(runtime.status().supportCleanupPending, true)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, SUPPORT_SESSION_ID)

  // 404: the row is gone, so there is nothing left to end.
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  assert.equal(ends.length, 3)
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().supportEndFailed, false)
  assert.equal(logs.some(line => line.includes('stranded support lease dropped: delegated_support_not_found')), true)
})

test('End reaches a cleanup-only lease and a start refuses to create over it until the broker ends it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-cleanup-only-end-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  let endOk = false
  let isolate = false
  let creates = 0
  const runtime = makeManagedRuntime(statePath, {
    // The server activates the lease inside the claim, the local launch (the
    // renderer isolation) fails, and the compensating end fails too: the app is
    // left holding a handle and no enrollment.
    resetRenderer: async () => isolate,
    brokerPost: async (body, options) => {
      if (body.action === 'create_internal_support_request') {
        creates += 1
        return supportRequestCreated()
      }
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        if (!endOk) throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const first = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(first.ok, false)
  assert.equal(first.code, 'support-renderer-reset-failed')
  assert.ok(ends.length >= 1)
  assert.equal(persistedSupportLease(statePath)?.phase, 'cleanup')
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(runtime.status().supportCleanupPending, true)

  // No second create while the first row is still owed an end.
  const blocked = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'cleanup_pending')
  assert.equal(blocked.code, 'support-cleanup-pending')
  assert.equal(creates, 1)

  // End sends the request with the session in hand and reports the failure;
  // nothing is dropped on a failed attempt.
  assert.deepEqual(await runtime.endSupportSession(), { ok: false })
  assert.deepEqual(ends.at(-1), { id: SUPPORT_SESSION_ID, desktopSession: 'desktop-token' })
  assert.equal(runtime.status().supportEndFailed, true)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, SUPPORT_SESSION_ID)

  endOk = true
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  assert.deepEqual(ends.at(-1), { id: SUPPORT_SESSION_ID, desktopSession: 'desktop-token' })
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().supportEndFailed, false)

  isolate = true
  const started = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(started.ok, true)
  assert.equal(creates, 2)
})

test('a desktop session the broker returned without an email never creates an unscoped lease', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-no-actor-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  delete persisted.desktop.email
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  const actions = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      actions.push(body.action)
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  // Nothing is created, so nothing needs a handle: the operator signs in again
  // and gets a session that owns what it starts.
  const start = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(start.ok, false)
  assert.equal(start.reason, 'needs_sign_in')
  assert.equal(start.code, 'sign-in-required')
  assert.deepEqual(actions, [])
  assert.equal(persistedSupportLease(statePath), null)
})

test('a confirmed end after a failed isolation drops the handle and the next start creates immediately', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-confirmed-end-settles-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  let isolate = false
  let creates = 0
  const runtime = makeManagedRuntime(statePath, {
    // The server activates the lease inside the claim and the local launch
    // fails, so the claim compensates with an end the server ACCEPTS. Every
    // later end for that now-ended row is what production answers: 403
    // `delegated_support_denied` — neither 404 nor 410, so not definitive.
    resetRenderer: async () => isolate,
    brokerPost: async (body, options) => {
      if (body.action === 'create_internal_support_request') {
        creates += 1
        return supportRequestCreated()
      }
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        if (ends.filter(end => end.id === body.support_session_id).length > 1) {
          throw brokerRejection(403, 'delegated_support_denied')
        }
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const first = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(first.ok, false)
  assert.equal(first.code, 'support-renderer-reset-failed')
  // Exactly ONE end for that row: the outer failure handler must not send the
  // second one that would earn the 403 and strand a `cleanup` handle.
  assert.deepEqual(ends, [{ id: SUPPORT_SESSION_ID, desktopSession: 'desktop-token' }])
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().delegatedSupportActive, false)

  // Nothing is owed an end, so the next start creates straight away.
  isolate = true
  const started = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(started.ok, true)
  assert.equal(creates, 2)
  assert.equal(ends.length, 1)
})

test('a failed compensating end keeps the handle and leaves the outer end as the one retry', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-failed-compensating-end-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  let creates = 0
  const runtime = makeManagedRuntime(statePath, {
    resetRenderer: async () => false,
    brokerPost: async (body, options) => {
      if (body.action === 'create_internal_support_request') {
        creates += 1
        return supportRequestCreated()
      }
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        throw brokerRejection(503, 'delegated_support_unavailable')
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const first = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(first.ok, false)
  assert.equal(first.code, 'support-renderer-reset-failed')
  // The compensating end never landed, so the row is still owed one: the outer
  // handler's attempt is that single retry, and the handle survives it.
  assert.equal(ends.length, 2)
  assert.deepEqual(ends.at(-1), { id: SUPPORT_SESSION_ID, desktopSession: 'desktop-token' })
  assert.equal(persistedSupportLease(statePath)?.support_session_id, SUPPORT_SESSION_ID)
  assert.equal(persistedSupportLease(statePath)?.phase, 'cleanup')
  assert.equal(runtime.status().supportCleanupPending, true)

  const blocked = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(blocked.reason, 'cleanup_pending')
  assert.equal(creates, 1)
})

test('a desktop credential that expires during an active lease leaves a cleanup handle the next sign-in ends', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-desktop-expiry-keeps-lease-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  const first = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  await first.claimSupportRequest('request-123')
  await first.close()

  // The claim keeps the lease id beside the enrollment, with the server deadline.
  const active = persistedSupportLease(statePath)
  assert.equal(active?.support_session_id, 'support-session')
  assert.equal(active?.phase, 'active')
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(active?.support_expires_at, JSON.parse(persisted.delegated_support.enrollment).support_expires_at)

  // The desktop credential expires while the hour-long lease is still active
  // server-side; the next boot clears the enrollment it can no longer resume.
  persisted.desktop.expires_at = EXPIRED
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  let opened
  const runtime = makeManagedRuntime(statePath, {
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'next-desktop-session', expiresAt: FUTURE, email: 'employee@example.invalid' }),
    launchRuntime: async () => freshRuntimeEnrollment(),
    brokerPost: async (body, options) => {
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))

  // Losing the credential is not ending the row: the id survives as a cleanup
  // handle, and nothing was sent without a credential to send it with.
  assert.deepEqual(ends, [])
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).delegated_support ?? null, null)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, 'support-session')
  assert.equal(persistedSupportLease(statePath)?.phase, 'cleanup')
  assert.equal(runtime.status().delegatedSupportActive, false)
  // Not shown until the owner is authenticated again; the handle is on disk.
  assert.equal(runtime.status().supportCleanupPending, false)

  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )
  await signingIn
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(ends, [{ id: 'support-session', desktopSession: 'next-desktop-session' }])
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().runtimeSessionActive, true)
})

test('a start on a desktop credential about to expire asks for a plain sign-in before creating a lease', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-start-expiring-credential-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.desktop.expires_at = new Date(Date.now() + 3 * 60 * 1_000).toISOString()
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  let brokerCalls = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => {
      brokerCalls += 1
      throw new Error('must not be called')
    }
  })
  t.after(() => runtime.close())

  // Three minutes of credential cannot end an hour-long lease later; the
  // picker routes `needs_sign_in` to the plain sign-in that fixes it.
  const result = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'needs_sign_in')
  assert.equal(result.code, 'desktop-session-expiring')
  assert.equal(brokerCalls, 0)
  assert.equal(runtime.status().desktopSessionActive, true)
})

test('boot ends a stranded lease handle left by an interrupted start', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-boot-ends-stranded-lease-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: SUPPORT_SESSION_ID,
    request_id: SUPPORT_REQUEST_ID,
    target_label: 'Acme / Asuka',
    phase: 'pending',
    recorded_at: new Date().toISOString()
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  const ends = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'internal_support_session_end') {
        ends.push(body.support_session_id)
        return { ok: true }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(ends, [SUPPORT_SESSION_ID])
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().desktopSessionActive, true)
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('a stale lease handle is dropped on read instead of retried for the life of the install', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-stale-lease-handle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: SUPPORT_SESSION_ID,
    phase: 'cleanup',
    recorded_at: new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString()
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  let ends = 0
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => {
      ends += 1
      throw new Error('must not be called')
    }
  })
  t.after(() => runtime.close())

  await new Promise(resolve => setImmediate(resolve))

  assert.equal(ends, 0)
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('a late callback with no pending sign-in is logged instead of dropped silently', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-late-callback-log-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  const logs = []
  const runtime = makeManagedRuntime(statePath, { rememberLog: line => logs.push(line) })
  t.after(() => runtime.close())

  assert.equal(await runtime.completeCallback('evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=late'), false)
  assert.deepEqual(logs, ['[eva-auth] callback ignored: no-pending'])
})

test('the directory caps count startable rows, so unusable rows cannot crowd valid ones out', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-directory-cap-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async () => ({
      ok: true,
      is_admin: false,
      clients: [
        // 500 rows without a VM precede the one row an operator can start.
        ...Array.from({ length: 500 }, (_, index) => ({
          customer_account_id: SUPPORT_ACCOUNT_ID,
          customer_vm_id: null,
          display_name: `Unusable ${index}`,
          profiles: [{ profile_id: 'main', display_name: 'A' }]
        })),
        {
          customer_account_id: SUPPORT_ACCOUNT_ID,
          customer_vm_id: SUPPORT_VM_ID,
          display_name: 'Acme',
          // 200 malformed profiles precede the one that can be chosen.
          profiles: [
            ...Array.from({ length: 200 }, (_, index) => ({ profile_id: `bad profile ${index}!`, display_name: 'x' })),
            { profile_id: 'main', display_name: 'Asuka' }
          ]
        }
      ]
    })
  })
  t.after(() => runtime.close())

  const result = await runtime.listSupportTargets()

  assert.equal(result.ok, true)
  assert.deepEqual(result.clients, [
    {
      customer_account_id: SUPPORT_ACCOUNT_ID,
      customer_vm_id: SUPPORT_VM_ID,
      display_name: 'Acme',
      profiles: [{ profile_id: 'main', display_name: 'Asuka' }]
    }
  ])
})

test("a superseded start's late end never clears or rewrites a handle a newer start has persisted", async t => {
  for (const endOutcome of ['ok', 'transport-error']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `eva-support-late-release-${endOutcome}-`))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const statePath = path.join(directory, 'eva-enrollment.json')
    writeActiveEnrollment(statePath)
    let runtime
    runtime = makeManagedRuntime(statePath, {
      brokerPost: async body => {
        if (body.action === 'create_internal_support_request') {
          // The operator signs out while the broker is still answering, so the
          // created row is released instead of claimed.
          await runtime.signOut()
          return supportRequestCreated()
        }
        if (body.action === 'internal_support_session_end') {
          // Before that release lands, a newer start has already settled this
          // row and persisted its own handle for a different one.
          const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
          persisted.support_leases = [
            {
              support_session_id: 'newer-session',
              phase: 'pending',
              recorded_at: new Date().toISOString()
            }
          ]
          fs.writeFileSync(statePath, JSON.stringify(persisted))
          if (endOutcome === 'ok') return { ok: true, status: 'ended' }
          throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
        }
        throw new Error(`unexpected action ${body.action}`)
      }
    })
    t.after(() => runtime.close())

    const result = await runtime.startDelegatedSupport(supportTarget())

    assert.equal(result.reason, 'needs_sign_in')
    // The newer handle is untouched: neither cleared by the ok nor rewritten
    // into the superseded row's cleanup state by the failure.
    assert.deepEqual(persistedSupportLease(statePath), {
      support_session_id: 'newer-session',
      phase: 'pending',
      recorded_at: persistedSupportLease(statePath).recorded_at
    })
  }
})

test('ending the current lease keeps a stranded handle for a different row until the broker ends that one too', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-surviving-handle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: 'stranded-session',
    target_label: 'Acme / Asuka',
    phase: 'cleanup',
    recorded_at: new Date().toISOString(),
    actor_email: 'employee@example.invalid'
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  const ends = []
  let strandedEndOk = false
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        ends.push(body.support_session_id)
        if (body.support_session_id === 'stranded-session' && !strandedEndOk) {
          throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
        }
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ends, ['stranded-session'])

  // A browser-flow claim lands while the stranded row is still owed its end:
  // the enrollment owns 'support-session', the handle keeps 'stranded-session'.
  await runtime.claimSupportRequest('request-123')
  assert.equal(runtime.status().delegatedSupportActive, true)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, 'stranded-session')

  // Ending the CURRENT lease confirms only that row: the other handle survives.
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  assert.equal(ends.at(-1), 'support-session')
  assert.equal(runtime.status().delegatedSupportActive, false)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, 'stranded-session')
  assert.equal(persistedSupportLease(statePath)?.phase, 'cleanup')
  assert.equal(runtime.status().supportCleanupPending, true)

  strandedEndOk = true
  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  assert.equal(ends.at(-1), 'stranded-session')
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('a stranded handle settled while End is in flight is not written back by the confirmed end', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-end-out-of-order-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: 'stranded-session',
    phase: 'cleanup',
    recorded_at: new Date().toISOString(),
    actor_email: 'employee@example.invalid'
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  const ends = []
  let duringEnd = null
  let settleStranded
  const strandedSettled = new Promise(resolve => {
    settleStranded = resolve
  })
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        ends.push(body.support_session_id)
        // The boot-time end of the stranded row is still pending when End is
        // pressed; it completes while the current row's end is in flight.
        if (body.support_session_id === 'stranded-session') return strandedSettled
        settleStranded({ ok: true, status: 'ended' })
        for (let tick = 0; tick < 4; tick += 1) await new Promise(resolve => setImmediate(resolve))
        duringEnd = persistedSupportLeases(statePath).map(lease => lease.support_session_id)
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ends, ['stranded-session'])
  await runtime.claimSupportRequest('request-123')

  assert.deepEqual(await runtime.endSupportSession(), { ok: true })
  await new Promise(resolve => setImmediate(resolve))

  // The stranded handle was already gone while the current end was in flight;
  // both rows are settled at the broker and neither handle comes back.
  assert.deepEqual(duringEnd, ['support-session'])
  assert.deepEqual(ends, ['stranded-session', 'support-session'])
  assert.deepEqual(persistedSupportLeases(statePath), [])
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('a created row whose response carries no usable expiry still gets its handle and is claimed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-create-no-expiry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'create_internal_support_request') {
        return { ...supportRequestCreated(), request_expires_at: 'not a date' }
      }
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  // The ids name a row that already exists server-side; the expiry is not
  // load-bearing, so the row is neither refused nor left without a handle.
  assert.equal((await runtime.startDelegatedSupport(supportTarget())).ok, true)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, SUPPORT_SESSION_ID)
  assert.equal(runtime.status().delegatedSupportActive, true)
})

test("another employee's stranded handle is neither retried with this session nor allowed to block it", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-foreign-handle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  const first = makeManagedRuntime(statePath, {
    brokerPost: async (body, options) => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
      }
      throw new Error(`unexpected action ${body.action}`)
    },
    revokeDesktopSession: async () => false
  })
  await first.claimSupportRequest('request-123')
  await first.signOut()
  await first.close()
  assert.equal(persistedSupportLease(statePath)?.actor_email, 'employee@example.invalid')

  // A different employee signs in on the same install.
  const logs = []
  let opened
  const runtime = makeManagedRuntime(statePath, {
    rememberLog: line => logs.push(line),
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'other-desktop-session', expiresAt: FUTURE, email: 'Other@example.invalid' }),
    launchRuntime: async () => freshRuntimeEnrollment(),
    brokerPost: async (body, options) => {
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        throw brokerRejection(403, 'delegated_support_denied')
      }
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )
  await signingIn
  await new Promise(resolve => setImmediate(resolve))

  // Not this account's lease: no end is sent with its session (a guaranteed
  // 403), no cleanup banner is shown to it, and its own start is not blocked.
  assert.equal(ends.length, 1)
  assert.equal(runtime.status().supportCleanupPending, false)
  assert.equal(runtime.status().supportTargetLabel, null)
  assert.equal(persistedSupportLease(statePath)?.support_session_id, 'support-session')
  assert.equal(logs.some(line => line.includes('belongs to another account; left for its owner')), true)

  const started = await runtime.startDelegatedSupport(supportTarget())
  assert.equal(started.ok, true)
  assert.equal(ends.length, 1)
  // A's handle survives beside B's own, for A's next sign-in to end.
  assert.deepEqual(
    persistedSupportLeases(statePath).map(lease => [lease.support_session_id, lease.phase, lease.actor_email]),
    [
      ['support-session', 'cleanup', 'employee@example.invalid'],
      [SUPPORT_SESSION_ID, 'active', 'Other@example.invalid']
    ]
  )
})

test('sign-out ends every row this account holds a handle for and keeps only the ones the broker did not settle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-signout-ends-every-handle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: 'stranded-session',
    target_label: 'Acme / Asuka',
    phase: 'cleanup',
    recorded_at: new Date().toISOString(),
    actor_email: 'employee@example.invalid'
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  const ends = []
  let strandedEndOk = false
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        ends.push(body.support_session_id)
        if (body.support_session_id === 'stranded-session' && strandedEndOk) return { ok: true, status: 'ended' }
        throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
      }
      throw new Error(`unexpected action ${body.action}`)
    },
    revokeDesktopSession: async () => false
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ends, ['stranded-session'])

  // A browser-flow claim lands over the stranded row: two handles, two rows.
  await runtime.claimSupportRequest('request-123')
  strandedEndOk = true
  assert.deepEqual(await runtime.signOut(), { ok: true })

  // Both rows were ended with the session being given up; the one the broker
  // settled is gone, the one it did not (the enrollment's own) is kept for the
  // next sign-in — the active grant is never the handle that gets lost.
  assert.deepEqual(ends.slice(1).sort(), ['stranded-session', 'support-session'])
  assert.deepEqual(
    persistedSupportLeases(statePath).map(lease => [lease.support_session_id, lease.phase]),
    [['support-session', 'cleanup']]
  )
  assert.equal(runtime.status().signedOut, true)
  assert.equal(runtime.status().supportCleanupPending, false)
})

test('a forced plain sign-in re-homes the renderer only when it comes back as a different account', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-switch-account-change-reset-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeEnrollment(statePath)
  let resets = 0
  let email = 'Employee@example.invalid'
  let agent = 'main'
  let opened
  const runtime = makeManagedRuntime(statePath, {
    resetRenderer: async () => {
      resets += 1
    },
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'next-desktop-session', expiresAt: FUTURE, email }),
    launchRuntime: async () => ({ ...freshRuntimeEnrollment(), agentId: agent, agentDisplayName: agent })
  })
  t.after(() => runtime.close())

  const signInAgain = async () => {
    const switching = runtime.switchSupportTarget({ signInAgain: true })
    await new Promise(resolve => setImmediate(resolve))
    await runtime.completeCallback(
      `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
    )
    return switching
  }

  // Same account (case-insensitively): the picker that asked stays open.
  await signInAgain()
  assert.equal(resets, 0)
  assert.equal(runtime.status().email, 'Employee@example.invalid')

  // A different account: account-scoped renderer state is re-homed.
  email = 'other@example.invalid'
  await signInAgain()
  assert.equal(resets, 1)
  assert.equal(runtime.status().email, 'other@example.invalid')

  // The same account, newly bound to another agent: re-homed as well, exactly
  // as `refresh()` treats a changed customer or agent id.
  agent = 'ops'
  await signInAgain()
  assert.equal(resets, 2)
  assert.equal(runtime.status().agentId, 'ops')
})

test('a sign-out that lands while the forced re-sign-in ends the active session stops the sign-in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-switch-signin-again-raced-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let opened = 0
  let runtime
  runtime = makeManagedRuntime(statePath, {
    openExternal: async () => {
      opened += 1
    },
    brokerPost: async body => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        // Another window signs out while the end is in flight.
        await runtime.signOut()
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  await runtime.claimSupportRequest('request-123')
  await assert.rejects(
    runtime.switchSupportTarget({ signInAgain: true }),
    error => error instanceof EvaBrokerError && error.code === 'stale-auth'
  )
  // The newer signed-out intent stands; no browser sign-in was started over it.
  assert.equal(opened, 0)
  assert.equal(runtime.status().signedOut, true)
})

test('a sign-out that lands while the forced re-sign-in prepares the browser sign-in stops it too', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-switch-signin-prep-raced-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  let opened = 0
  let runtime
  runtime = makeManagedRuntime(statePath, {
    openExternal: async () => {
      opened += 1
    },
    // No active support session this time: the only waits before the browser
    // opens are the sign-in's own — renderer isolation and the callback
    // handler. Another window signs out during the latter.
    ensureSignInCallbackReady: async () => {
      await runtime.signOut()
    },
    brokerPost: async body => {
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  await assert.rejects(
    runtime.switchSupportTarget({ signInAgain: true }),
    error => error instanceof EvaBrokerError && error.code === 'stale-auth'
  )
  assert.equal(opened, 0)
  assert.equal(runtime.status().signedOut, true)
})

test("a new start never evicts another employee's unexpired handle, however many are held", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-no-eviction-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  // More rows than any read cap would have kept: a shared installation whose
  // every sign-in stranded a lease within the hour.
  const foreign = Array.from({ length: 40 }, (_, index) => ({
    support_session_id: `other-session-${index}`,
    phase: 'cleanup',
    recorded_at: new Date().toISOString(),
    actor_email: `other-${index}@example.invalid`
  }))
  persisted.support_leases = foreign
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  const ends = []
  const runtime = makeManagedRuntime(statePath, {
    brokerPost: async body => {
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      if (body.action === 'internal_support_session_end') {
        ends.push(body.support_session_id)
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  const started = await runtime.startDelegatedSupport(supportTarget())

  assert.equal(started.ok, true)
  // Every other employee's handle is still there beside this account's own.
  assert.deepEqual(
    persistedSupportLeases(statePath).map(lease => lease.support_session_id),
    [...foreign.map(lease => lease.support_session_id), SUPPORT_SESSION_ID]
  )

  // The row this account created is still reachable: sign-out ends it at the
  // broker and drops only that handle.
  await runtime.signOut()

  assert.deepEqual(ends, [SUPPORT_SESSION_ID])
  assert.deepEqual(
    persistedSupportLeases(statePath).map(lease => lease.support_session_id),
    foreign.map(lease => lease.support_session_id)
  )
})

test("a cleanup still running for one account is never handed to the next account's start", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-support-cleanup-per-account-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.support_lease = {
    support_session_id: 'stranded-session',
    phase: 'cleanup',
    recorded_at: new Date().toISOString(),
    actor_email: 'employee@example.invalid'
  }
  fs.writeFileSync(statePath, JSON.stringify(persisted))
  let opened
  const runtime = makeManagedRuntime(statePath, {
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'other-desktop-session', expiresAt: FUTURE, email: 'other@example.invalid' }),
    launchRuntime: async () => freshRuntimeEnrollment(),
    brokerPost: async body => {
      // The first account's stranded end never answers.
      if (body.action === 'internal_support_session_end') return new Promise(() => undefined)
      if (body.action === 'create_internal_support_request') return supportRequestCreated()
      if (body.action === 'claim_internal_support_request') {
        return supportEnrollment(Date.now(), { support_session_id: SUPPORT_SESSION_ID })
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())
  await new Promise(resolve => setImmediate(resolve))

  // A different employee signs in while that cleanup is still hanging.
  const signingIn = runtime.signIn()
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )
  await signingIn

  // Their start neither waits on the first account's cleanup nor mistakes it
  // for its own: it runs cleanup for the account in hand and proceeds.
  const started = await Promise.race([
    runtime.startDelegatedSupport(supportTarget()),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'timed-out' }), 3_000))
  ])
  assert.equal(started.ok, true)
  assert.equal(persistedSupportLeases(statePath).some(lease => lease.support_session_id === 'stranded-session'), true)
})

test('a plain sign-in that loses its session mid-enrollment reports the sign-out instead of a stale success', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-plain-signin-stale-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  let opened
  let runtime
  runtime = makeManagedRuntime(statePath, {
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'next-desktop-session', expiresAt: FUTURE, email: 'employee@example.invalid' }),
    launchRuntime: async () => {
      // The operator signs out while the enrollment is still in flight.
      await runtime.signOut()
      return freshRuntimeEnrollment()
    }
  })
  t.after(() => runtime.close())

  const switching = runtime.switchSupportTarget({ signInAgain: true })
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )

  await assert.rejects(switching, error => error instanceof EvaBrokerError && error.code === 'stale-auth')
  assert.equal(runtime.status().signedOut, true)
  assert.equal(runtime.status().desktopSessionActive, false)
  assert.equal(runtime.status().supportPickerAvailable, false)
})

test('a forced re-sign-in during an active support session whose credential the broker rejects keeps the lease handle and ends it with the new session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-switch-signin-again-active-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'eva-enrollment.json')
  writeActiveEnrollment(statePath)
  const ends = []
  let opened
  const runtime = makeManagedRuntime(statePath, {
    openExternal: async url => {
      opened = new URL(url)
    },
    pollDeviceCode: async () => ({ token: 'next-desktop-session', expiresAt: FUTURE, email: 'employee@example.invalid' }),
    launchRuntime: async () => freshRuntimeEnrollment(),
    brokerPost: async (body, options) => {
      if (body.action === 'claim_internal_support_request') return supportEnrollment()
      if (body.action === 'internal_support_session_end') {
        ends.push({ id: body.support_session_id, desktopSession: options?.desktopSession })
        // The broker has invalidated the first desktop session: its end is
        // refused exactly like the directory listing that sent the operator
        // to the picker's Sign in action.
        if (options?.desktopSession === 'desktop-token') throw brokerRejection(401, 'eva_desktop_session_required')
        return { ok: true, status: 'ended' }
      }
      throw new Error(`unexpected action ${body.action}`)
    }
  })
  t.after(() => runtime.close())

  await runtime.claimSupportRequest('request-123')
  assert.equal(runtime.status().delegatedSupportActive, true)

  const switching = runtime.switchSupportTarget({ signInAgain: true })
  await new Promise(resolve => setImmediate(resolve))
  await runtime.completeCallback(
    `evaos-agent://auth/callback?device_code=ABCDEFGH&desktop_auth_state=${opened.searchParams.get('desktop_auth_state')}`
  )
  const status = await switching
  await new Promise(resolve => setImmediate(resolve))

  // The sign-in was not refused; the row was ended with the NEW session once
  // the old credential could not, and the handle went only on the broker's ok.
  assert.deepEqual(ends, [
    { id: 'support-session', desktopSession: 'desktop-token' },
    { id: 'support-session', desktopSession: 'next-desktop-session' }
  ])
  assert.equal(status.delegatedSupportActive, false)
  assert.equal(status.desktopSessionActive, true)
  assert.equal(runtime.status().runtimeSessionActive, true)
  assert.equal(persistedSupportLease(statePath), null)
  assert.equal(runtime.status().supportCleanupPending, false)
})
