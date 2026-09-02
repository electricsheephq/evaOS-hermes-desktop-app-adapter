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
  assert.deepEqual(result.recents.sessions, [{ id: 'messaging' }])
  assert.deepEqual(result.cron.sessions, [{ id: 'cron' }])
  assert.deepEqual(result.messaging.sessions, [{ id: 'messaging' }])
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
  const request = runtime.requestApi({ method: 'GET', path: '/api/sessions', profile: 'support' })
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
