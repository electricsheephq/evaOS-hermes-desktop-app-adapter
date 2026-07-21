const assert = require('node:assert/strict')
const test = require('node:test')

const {
  EVA_MANAGED_POLICY,
  EvaBrokerError,
  assertEvaManagedApiRequestAllowed,
  buildEvaDesktopAuthUrl,
  buildEvaManagedWsUrl,
  launchEvaHermesRuntime,
  makeDeviceCode,
  managedUpdateResponse,
  normalizeHermesEnrollment,
  parseEvaDesktopAuthCallback,
  pollEvaDeviceCode,
  publicEvaEnrollmentStatus
} = require('./eva-managed.cjs')

const FUTURE = '2099-07-19T12:00:00.000Z'

test('managed policy is remote-only, account-neutral, and has no Nous endpoint', () => {
  const serialized = JSON.stringify(EVA_MANAGED_POLICY)
  assert.equal(Object.hasOwn(EVA_MANAGED_POLICY, 'customerId'), false)
  assert.equal(EVA_MANAGED_POLICY.runtime, 'hermes')
  assert.equal(EVA_MANAGED_POLICY.updateChannel, 'managed-beta')
  assert.equal(Object.hasOwn(EVA_MANAGED_POLICY, 'allowedAgentIds'), false)
  assert.equal(EVA_MANAGED_POLICY.runtimeHostSuffix, '.ecs.electricsheephq.com')
  assert.doesNotMatch(serialized, /nousresearch|portal\.nous|github\.com/i)
})

test('evaOS Agent auth URL carries a high-entropy fallback code and state but no agent selector', () => {
  const deviceCode = makeDeviceCode({ randomUUID: () => '12345678-1234-4abc-9def-1234567890ab' })
  const url = new URL(buildEvaDesktopAuthUrl(deviceCode, 'state-12345678'))
  assert.equal(deviceCode, '1234567812344ABC9DEF1234567890AB')
  assert.equal(url.origin + url.pathname, EVA_MANAGED_POLICY.dashboardAuthUrl)
  assert.equal(url.searchParams.get('callback_scheme'), 'evaos-agent')
  assert.equal(url.searchParams.get('fresh'), deviceCode)
  assert.equal(url.searchParams.get('desktop_auth_state'), 'state-12345678')
  assert.equal(url.searchParams.get('switch_account'), '1')
  assert.equal(url.searchParams.has('agent_id'), false)
})

test('device-code polling treats an unregistered code as pending and then accepts the opaque session', async () => {
  let requests = 0
  let clock = 1000
  const result = await pollEvaDeviceCode('A'.repeat(32), {
    now: () => clock,
    pollMs: 5,
    timeoutMs: 30,
    sleep: async delay => {
      clock += delay
    },
    fetchImpl: async (_url, init) => {
      requests += 1
      const body = JSON.parse(init.body)
      assert.deepEqual(body, { action: 'claim_desktop_device_code', device_code: 'A'.repeat(32) })
      if (requests === 1) {
        return new Response(JSON.stringify({ error: 'Invalid or expired one-time code' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify({
          desktop_session: 'eds_device_session',
          desktop_session_expires_at: FUTURE,
          email: 'employee@example.invalid'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
  })
  assert.equal(requests, 2)
  assert.equal(result.token, 'eds_device_session')
  assert.equal(result.email, 'employee@example.invalid')
})

test('device-code polling fails immediately on a malformed successful claim', async () => {
  let requests = 0
  let sleeps = 0
  await assert.rejects(
    pollEvaDeviceCode('A'.repeat(32), {
      now: () => 1000,
      timeoutMs: 30,
      sleep: async () => {
        sleeps += 1
      },
      fetchImpl: async () => {
        requests += 1
        return new Response(JSON.stringify({ desktop_session_expires_at: FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
    }),
    error => error instanceof EvaBrokerError && error.code === 'invalid-session'
  )
  assert.equal(requests, 1)
  assert.equal(sleeps, 0)
})

test('runtime launch lets the broker select the account and assigned agent', async () => {
  let observed = null
  const result = await launchEvaHermesRuntime('eds_desktop_session', {
    fetchImpl: async (url, init) => {
      observed = { url, init, body: JSON.parse(init.body) }
      return new Response(
        JSON.stringify({
          schema_version: 'evaos.hermes_desktop_enrollment.v1',
          runtime: 'hermes',
          customer_id: 'jackie-david',
          remote_backend: {
            base_url: 'https://hermes-jackie-david.ecs.electricsheephq.com/',
            session_token: 'opaque-runtime-session',
            expires_at: FUTURE,
            agent_id: 'jane'
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
  })

  assert.equal(observed.url, EVA_MANAGED_POLICY.brokerUrl)
  assert.equal(observed.init.headers.Authorization, 'Bearer eds_desktop_session')
  assert.deepEqual(observed.body, {
    action: 'runtime_launch',
    runtime: 'hermes',
    launch_mode: 'dashboard_surface',
    client_surface: 'eva_desktop'
  })
  assert.equal(Object.hasOwn(observed.body, 'customer_id'), false)
  assert.equal(Object.hasOwn(observed.body, 'agent_id'), false)
  assert.equal(result.agentId, 'jane')
  assert.equal(result.baseUrl, 'https://hermes-jackie-david.ecs.electricsheephq.com')
})

test('managed WebSocket transport uses only the ws-proxy Eva session parameter', () => {
  const url = new URL(buildEvaManagedWsUrl('https://hermes-jackie-david.ecs.electricsheephq.com', 'opaque-token'))
  assert.equal(url.protocol, 'wss:')
  assert.equal(url.pathname, '/api/ws')
  assert.equal(url.searchParams.get('eva_session'), 'opaque-token')
  assert.equal(url.searchParams.has('token'), false)
  assert.equal(url.searchParams.has('agent_id'), false)
})

test('managed backend allows ordinary agent traffic and read-only capability inspection', () => {
  assert.deepEqual(assertEvaManagedApiRequestAllowed({ path: '/api/sessions?limit=20&archived=exclude' }), {
    method: 'GET',
    path: '/api/sessions?archived=exclude&limit=20',
    pathname: '/api/sessions'
  })
  assert.deepEqual(assertEvaManagedApiRequestAllowed({ path: '/api/skills?profile=default' }), {
    method: 'GET',
    path: '/api/skills?profile=default',
    pathname: '/api/skills'
  })
  assert.deepEqual(assertEvaManagedApiRequestAllowed({ path: '/api/tools/toolsets' }), {
    method: 'GET',
    path: '/api/tools/toolsets',
    pathname: '/api/tools/toolsets'
  })
  assert.deepEqual(assertEvaManagedApiRequestAllowed({ path: '/api/profiles/sessions?profile=all&limit=20' }), {
    method: 'GET',
    path: '/api/profiles/sessions?limit=20&profile=all',
    pathname: '/api/profiles/sessions'
  })
  assert.deepEqual(
    assertEvaManagedApiRequestAllowed({
      path: '/api/sessions/session-1',
      method: 'PATCH',
      body: { archived: true }
    }),
    {
      method: 'PATCH',
      path: '/api/sessions/session-1',
      pathname: '/api/sessions/session-1'
    }
  )
})

test('managed file reads stay inside the assigned agent workspace and admin-files roots', () => {
  assert.deepEqual(
    assertEvaManagedApiRequestAllowed(
      { path: '/api/fs/read-text?path=%2Fsrv%2Fevaos%2Fagents%2Fjane%2FWelcome.md' },
      { agentId: 'jane' }
    ),
    {
      method: 'GET',
      path: '/api/fs/read-text?path=%2Fsrv%2Fevaos%2Fagents%2Fjane%2FWelcome.md',
      pathname: '/api/fs/read-text'
    }
  )
  assert.deepEqual(
    assertEvaManagedApiRequestAllowed(
      { path: '/api/fs/list?path=%2Fsrv%2Fevaos%2Fhermes-managed%2Flouis' },
      { agentId: 'louis' }
    ),
    {
      method: 'GET',
      path: '/api/fs/list?path=%2Fsrv%2Fevaos%2Fhermes-managed%2Flouis',
      pathname: '/api/fs/list'
    }
  )

  const denied = [
    [{ path: '/api/fs/read-text?path=%2Fvar%2Flib%2Fevaos%2Fhermes%2Fjane%2F.env' }, { agentId: 'jane' }],
    [{ path: '/api/fs/read-text?path=%2Fsrv%2Fevaos%2Fagents%2Fjackie%2FWelcome.md' }, { agentId: 'jane' }],
    [{ path: '/api/fs/read-text?path=%2Fsrv%2Fevaos%2Fagents%2Fjane%2F..%2Fjackie%2FWelcome.md' }, { agentId: 'jane' }],
    [{ path: '/api/fs/read-text?path=%2Fsrv%2Fevaos%2Fagents%2Fjane%2FWelcome.md' }, {}],
    [{ path: '/api/fs/read-text' }, { agentId: 'jane' }]
  ]
  for (const [request, options] of denied) {
    assert.throws(
      () => assertEvaManagedApiRequestAllowed(request, options),
      error => error instanceof EvaBrokerError && error.code === 'managed-policy'
    )
  }
})

test('managed backend blocks employee capability and runtime-policy mutations', () => {
  const denied = [
    { path: '/api/skills/hub/install', method: 'POST' },
    { path: '/api/skills/toggle', method: 'PUT' },
    { path: '/api/%2573kills/hub/install', method: 'POST' },
    { path: '/api/learning/node', method: 'DELETE' },
    { path: '/api/mcp/servers', method: 'PUT' },
    { path: '/api/tools/toolsets/web', method: 'PUT' },
    { path: '/api/config', method: 'PUT' },
    { path: '/api/model/set', method: 'POST' },
    { path: '/api/gateway/restart', method: 'POST' },
    { path: '/api/hermes/update', method: 'POST' },
    { path: '/api/profiles', method: 'POST' },
    { path: '/api/env/reveal', method: 'GET' },
    { path: '/api/files/upload', method: 'POST' },
    { path: '/api/cron/jobs', method: 'POST' },
    { path: '/api/sessions', method: 'POST' },
    { path: '/api/git/status?path=%2Fsrv%2Fagent', method: 'GET' }
  ]
  for (const request of denied) {
    assert.throws(
      () => assertEvaManagedApiRequestAllowed(request),
      error => error instanceof EvaBrokerError && error.statusCode === 403 && error.code === 'managed-policy'
    )
  }
})

test('managed backend rejects absolute, non-API, and ambiguous request paths', () => {
  for (const path of ['https://example.invalid/api/skills', '//example.invalid/api/skills', '/health', '/api/%zz']) {
    assert.throws(
      () => assertEvaManagedApiRequestAllowed({ path }),
      error => error instanceof EvaBrokerError && error.code === 'managed-policy'
    )
  }
})

test('managed backend validates query, profile, and session mutation shapes', () => {
  const denied = [
    { path: '/api/sessions?limit=20&limit=40' },
    { path: '/api/sessions?agent_id=jackie' },
    { path: '/api/fs/read-text?path=relative' },
    { path: '/api/skills?profile=all' },
    { path: '/api/skills', profile: 'jackie' },
    { path: '/api/sessions/session-1', method: 'PATCH', body: { title: 'ok', archived: true } },
    { path: '/api/sessions/session-1', method: 'PATCH', body: { agent_id: 'jane' } },
    { path: '/api/sessions/session-1', method: 'DELETE', body: {} }
  ]
  for (const request of denied) {
    assert.throws(
      () => assertEvaManagedApiRequestAllowed(request),
      error => error instanceof EvaBrokerError && error.code === 'managed-policy'
    )
  }
})

test('managed enrollment accepts server-selected accounts and rejects mismatched or malformed identities', () => {
  const payload = {
    schema_version: 'evaos.hermes_desktop_enrollment.v1',
    runtime: 'hermes',
    customer_id: 'jackie-david',
    remote_backend: {
      base_url: 'https://hermes-jackie-david.ecs.electricsheephq.com',
      session_token: 'opaque-runtime-session',
      expires_at: FUTURE,
      agent_id: 'louis'
    }
  }
  assert.equal(normalizeHermesEnrollment(payload).agentId, 'louis')
  const benjamin = normalizeHermesEnrollment({
    ...payload,
    customer_id: 'benjamin-kennedy',
    remote_backend: {
      ...payload.remote_backend,
      base_url: 'https://hermes-benjamin-kennedy.ecs.electricsheephq.com',
      agent_id: 'benjamin-agent'
    }
  })
  assert.equal(benjamin.customerId, 'benjamin-kennedy')
  assert.equal(benjamin.agentId, 'benjamin-agent')
  assert.throws(
    () => normalizeHermesEnrollment({ ...payload, customer_id: 'another-customer' }),
    error => error instanceof EvaBrokerError && error.code === 'wrong-customer'
  )
  assert.throws(
    () =>
      normalizeHermesEnrollment({
        ...payload,
        remote_backend: { ...payload.remote_backend, agent_id: '../client-selected-agent' }
      }),
    error => error instanceof EvaBrokerError && error.code === 'wrong-agent'
  )
  assert.throws(
    () =>
      normalizeHermesEnrollment({
        ...payload,
        remote_backend: { ...payload.remote_backend, base_url: 'http://127.0.0.1:9211' }
      }),
    error => error instanceof EvaBrokerError && error.code === 'invalid-enrollment'
  )
  for (const baseUrl of [
    'https://other-customer.ecs.electricsheephq.com',
    'https://hermes-jackie-david.ecs.electricsheephq.com/tenant',
    'https://hermes-jackie-david.ecs.electricsheephq.com.evil.invalid'
  ]) {
    assert.throws(
      () =>
        normalizeHermesEnrollment({
          ...payload,
          remote_backend: { ...payload.remote_backend, base_url: baseUrl }
        }),
      error => error instanceof EvaBrokerError && ['invalid-enrollment', 'wrong-customer'].includes(error.code)
    )
  }
})

test('evaOS Agent deep-link callback requires the exact in-flight auth state', () => {
  const raw = `evaos-agent://auth/callback?device_code=${'A'.repeat(32)}` + '&desktop_auth_state=state-12345678'
  assert.equal(parseEvaDesktopAuthCallback(raw, 'state-12345678').deviceCode, 'A'.repeat(32))
  assert.throws(
    () => parseEvaDesktopAuthCallback(raw, 'state-other-123'),
    error => error instanceof EvaBrokerError && error.code === 'state-mismatch'
  )
  assert.throws(
    () =>
      parseEvaDesktopAuthCallback(
        `evaos-agent://auth/callback?device_code=${'A'.repeat(32)}&desktop_session=leaked&desktop_auth_state=state-12345678`,
        'state-12345678'
      ),
    error => error instanceof EvaBrokerError && error.code === 'invalid-callback'
  )
  assert.throws(
    () => parseEvaDesktopAuthCallback(`${raw}&blueprint=unexpected`, 'state-12345678'),
    error => error instanceof EvaBrokerError && error.code === 'invalid-callback'
  )
})

test('managed updater responses are static and cannot call network, Git, or process APIs', () => {
  const check = managedUpdateResponse('check', 1234)
  const apply = managedUpdateResponse('apply', 1234)
  const implementation = managedUpdateResponse.toString()

  assert.deepEqual(check, {
    supported: false,
    branch: 'managed-beta',
    message: 'Updates are managed by Electric Sheep.',
    fetchedAt: 1234
  })
  assert.deepEqual(apply, {
    ok: false,
    error: 'managed-beta',
    message: 'Updates are managed by Electric Sheep.'
  })
  assert.doesNotMatch(
    implementation,
    /fetch\s*\(|https?:|spawn\s*\(|exec(?:File|Sync)?\s*\(|\bgit\b|ls-remote|nousresearch/i
  )
})

test('renderer-facing enrollment status never exposes tokens or backend URLs', () => {
  const status = publicEvaEnrollmentStatus({
    desktop: { token: 'desktop-secret', expiresAt: FUTURE, email: 'employee@example.invalid' },
    runtime: {
      token: 'runtime-secret',
      expiresAt: FUTURE,
      customerId: 'jackie-david',
      agentId: 'jane',
      baseUrl: 'https://secret-endpoint.example'
    }
  })
  const serialized = JSON.stringify(status)
  assert.equal(status.agentId, 'jane')
  assert.doesNotMatch(serialized, /desktop-secret|runtime-secret|secret-endpoint/)
})
