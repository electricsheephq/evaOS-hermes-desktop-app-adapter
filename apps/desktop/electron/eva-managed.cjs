const crypto = require('node:crypto')
const { version: EVA_DESKTOP_PACKAGE_VERSION } = require('../package.json')

const EVA_MANAGED_POLICY = Object.freeze({
  schemaVersion: 'evaos.eva_desktop_managed.v1',
  enrollmentSchemaVersion: 'evaos.hermes_desktop_enrollment.v1',
  productName: 'evaOS Agent',
  dashboardAuthUrl: 'https://www.electricsheephq.com/desktop-auth',
  brokerUrl: 'https://rhfojelkgtwcxnrfhtlj.supabase.co/functions/v1/desktop-runtime-session',
  runtime: 'hermes',
  launchMode: 'dashboard_surface',
  clientSurface: 'eva_desktop',
  callbackScheme: 'evaos-agent',
  updateChannel: 'managed-beta',
  deviceCodePollMs: 1_500,
  loginTimeoutMs: 180_000,
  brokerRequestTimeoutMs: 15_000,
  runtimeRefreshSkewMs: 60_000,
  runtimeHostSuffix: '.ecs.electricsheephq.com'
})

const EVA_MANAGED_API_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'])
const EVA_MANAGED_ESCAPE_FIELDS = new Set([
  'agentId',
  'agent_id',
  'baseUrl',
  'base_url',
  'customerId',
  'customer_id',
  'gatewayUrl',
  'gateway_url',
  'sessionToken',
  'session_token',
  'token',
  'url'
])
const EVA_MANAGED_ESCAPE_QUERY_KEYS = new Set([
  'agent',
  'agent_id',
  'base_url',
  'customer',
  'customer_id',
  'eva_session',
  'gateway',
  'gateway_url',
  'session_token',
  'token'
])
const EVA_MANAGED_BLOCKED_BACKEND_PATHS = new Set(['/api/hermes/update', '/api/hermes/update/check'])
const EVA_MANAGED_BLOCKED_BACKEND_PREFIXES = ['/api/providers/oauth/nous']
const EVA_MANAGED_HIDDEN_NOUS_GATEWAY_METHODS = new Set([
  'billing.state',
  'billing.charge',
  'billing.auto_reload',
  'billing.step_up',
  'subscription.state',
  'subscription.change',
  'subscription.resume',
  'subscription.upgrade',
  'usage.bars'
])
const EVA_MANAGED_BLOCKED_GATEWAY_PREFIXES = ['billing.', 'subscription.']
const EVA_MANAGED_HIDDEN_NOUS_COMMANDS = new Set(['subscription', 'topup', 'upgrade'])
const EVA_MANAGED_PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const EVA_MANAGED_PROFILE_SELECTORS = new Set(['all'])
const EVA_SUPPORT_SESSION_KIND = 'delegated_support'
const EVA_SUPPORT_MAX_DURATION_MS = 60 * 60 * 1_000
const EVA_MANAGED_BROKER_CODE_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/
const EVA_MANAGED_SAFE_BROKER_CODES = new Set([
  'ambiguous_hermes_agent_binding',
  'client_agent_override_not_allowed',
  'client_customer_override_not_allowed',
  'client_download_override_not_allowed',
  'company_brain_denied',
  'eva_desktop_session_required',
  'evaos_agent_download_forbidden',
  'evaos_agent_download_unavailable',
  'feature_not_enabled',
  'invalid_client_surface',
  'invalid_eva_runtime',
  'invalid_hermes_agent_binding',
  'invalid_launch_mode',
  'invalid_release_track',
  'invalid_request',
  'missing_hermes_agent_binding',
  'missing_runtime_permission',
  'provider_ambiguous',
  'revoke_upstream_failed',
  'support_actor_mismatch',
  'support_assignment_mismatch',
  'support_assignment_revoked',
  'support_request_replayed',
  'support_session_active',
  'support_session_expired'
])
const EVA_ACCOUNT_SCOPED_RENDERER_STORAGE_KEYS = Object.freeze([
  'hermes.desktop.composerQueue.v1',
  'hermes.desktop.dismissedAutoProjects',
  'hermes.desktop.dismissedWorktrees',
  'hermes.desktop.inflightTurnJournal.v1',
  'hermes.desktop.lastRoute',
  'hermes.desktop.lastSessionId',
  'hermes.desktop.layoutTree.v2',
  'hermes.desktop.paneStates.v1',
  'hermes.desktop.pinnedSessions',
  'hermes.desktop.prBranchBySession',
  'hermes.desktop.prScannedSessions',
  'hermes.desktop.previewTabs.v2',
  'hermes.desktop.profileColors',
  'hermes.desktop.profileOrder',
  'hermes.desktop.projectOrder',
  'hermes.desktop.projectScope',
  'hermes.desktop.routeTiles.v1',
  'hermes.desktop.sessionOrder',
  'hermes.desktop.sessionPreviews.v1',
  'hermes.desktop.sessionTiles.v1',
  'hermes.desktop.sessionTiles.v2',
  'hermes.desktop.sidebarMessagingOpen',
  'hermes.desktop.terminals.v1',
  'hermes.desktop.toolDisclosure.v1',
  'hermes.desktop.userPlacedPanes.v1',
  'hermes.desktop.workspaceCollapsed',
  'hermes.desktop.workspaceNodeOpen',
  'hermes.desktop.workspaceOrder',
  'hermes.desktop.workspaceParentOrder',
  'hermes.desktop.workspace-cwd',
  'hermes:composer-drafts:v3',
  'hermes-desktop-active-profile-v1',
  'hermes-desktop-profile-modes-v1',
  'hermes-desktop-profile-themes-v1'
])
const EVA_ACCOUNT_SCOPED_RENDERER_STORAGE_PREFIXES = Object.freeze([
  'hermes.desktop.inflightTurnJournal.',
  'hermes.desktop.lastRoute.',
  'hermes.desktop.lastSessionId.',
  'hermes.desktop.pinnedSessions.remote.',
  'hermes.desktop.sessionOrder.manual.remote.',
  'hermes.desktop.sessionOrder.remote.',
  'hermes.desktop.workspace-cwd.remote.',
  'hermes.plugin.hermes-bots.',
  'hermes.transcript-tail.'
])

class EvaBrokerError extends Error {
  constructor(message, statusCode = null, code = 'broker-error') {
    super(message)
    this.name = 'EvaBrokerError'
    this.statusCode = statusCode
    this.code = code
  }
}

function normalizeEvaManagedBrokerCode(value) {
  const code = String(value || '').trim().toLowerCase()
  return code.length <= 64 && EVA_MANAGED_BROKER_CODE_RE.test(code) && EVA_MANAGED_SAFE_BROKER_CODES.has(code)
    ? code
    : null
}

function normalizeEvaManagedApiPath(value) {
  const rawPath = String(value || '')
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) {
    throw new EvaBrokerError('evaOS Agent blocked an invalid managed-backend request.', 400, 'managed-policy')
  }

  let parsed
  try {
    parsed = new URL(rawPath, 'https://eva-managed.invalid')
  } catch {
    throw new EvaBrokerError('evaOS Agent blocked an invalid managed-backend request.', 400, 'managed-policy')
  }
  if (parsed.origin !== 'https://eva-managed.invalid' || !parsed.pathname.startsWith('/api/')) {
    throw new EvaBrokerError('evaOS Agent blocked a request outside the managed API.', 403, 'managed-policy')
  }

  let pathname = parsed.pathname
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      throw new EvaBrokerError('evaOS Agent blocked an invalid managed-backend request.', 400, 'managed-policy')
    }
    if (decoded === pathname) break
    pathname = decoded
  }
  pathname = pathname.replace(/\/+/g, '/')
  const segments = pathname.split('/')
  if (
    pathname.includes('%') ||
    pathname.includes('\\') ||
    pathname.includes('?') ||
    pathname.includes('#') ||
    hasAsciiControl(pathname) ||
    segments.some(segment => segment === '.' || segment === '..') ||
    !pathname.startsWith('/api/')
  ) {
    throw new EvaBrokerError('evaOS Agent blocked an ambiguous managed-backend request.', 400, 'managed-policy')
  }
  return { parsed, pathname }
}

function hasAsciiControl(value) {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f
  })
}

function buildEvaAccountRendererResetScript() {
  const exactKeys = JSON.stringify(EVA_ACCOUNT_SCOPED_RENDERER_STORAGE_KEYS)
  const prefixes = JSON.stringify(EVA_ACCOUNT_SCOPED_RENDERER_STORAGE_PREFIXES)
  return `(() => {
    const exactKeys = new Set(${exactKeys});
    const prefixes = ${prefixes};
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && (exactKeys.has(key) || prefixes.some(prefix => key.startsWith(prefix)))) {
        localStorage.removeItem(key);
      }
    }
  })()`
}

function assertEvaManagedApiRequestAllowed(request, options = {}) {
  const method = String(request?.method || 'GET').toUpperCase()
  if (!EVA_MANAGED_API_METHODS.has(method)) {
    throw new EvaBrokerError('evaOS Agent blocked an invalid managed-backend method.', 400, 'managed-policy')
  }
  for (const key of EVA_MANAGED_ESCAPE_FIELDS) {
    if (Object.hasOwn(request ?? {}, key)) {
      throw new EvaBrokerError(
        'evaOS Agent connection and assignment are managed by Electric Sheep.',
        403,
        'managed-escape'
      )
    }
  }

  const { parsed, pathname } = normalizeEvaManagedApiPath(request?.path)
  const policyPath = pathname.length > '/api/'.length ? pathname.replace(/\/+$/, '') : pathname
  if (
    EVA_MANAGED_BLOCKED_BACKEND_PATHS.has(policyPath) ||
    EVA_MANAGED_BLOCKED_BACKEND_PREFIXES.some(
      prefix => policyPath === prefix || policyPath.startsWith(`${prefix}/`)
    )
  ) {
    throw new EvaBrokerError('This action is unavailable for managed evaOS Agent accounts.', 403, 'managed-escape')
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (EVA_MANAGED_ESCAPE_QUERY_KEYS.has(key)) {
      throw new EvaBrokerError(
        'evaOS Agent connection and assignment are managed by Electric Sheep.',
        403,
        'managed-escape'
      )
    }
    if (hasAsciiControl(key) || hasAsciiControl(value)) {
      throw new EvaBrokerError('evaOS Agent blocked an invalid managed query.', 400, 'managed-policy')
    }
  }

  const routingProfile = request?.profile == null ? null : String(request.profile)
  if (routingProfile !== null && !EVA_MANAGED_PROFILE_RE.test(routingProfile)) {
    throw new EvaBrokerError('evaOS Agent blocked an invalid Hermes profile.', 400, 'managed-policy')
  }
  const endpointProfiles = parsed.searchParams.getAll('profile')
  if (endpointProfiles.length > 1) {
    throw new EvaBrokerError('evaOS Agent blocked duplicate Hermes profiles.', 400, 'managed-policy')
  }
  if (endpointProfiles.length === 1) {
    const endpointProfile = endpointProfiles[0]
    if (routingProfile === null || !EVA_MANAGED_PROFILE_RE.test(endpointProfile)) {
      throw new EvaBrokerError('evaOS Agent blocked an invalid Hermes profile.', 400, 'managed-policy')
    }
    if (
      endpointProfile !== routingProfile &&
      (options.allowBroadProfileSelectors === false || !EVA_MANAGED_PROFILE_SELECTORS.has(endpointProfile))
    ) {
      throw new EvaBrokerError(
        'evaOS Agent connection and assignment are managed by Electric Sheep.',
        403,
        'managed-escape'
      )
    }
  } else if (routingProfile !== null) {
    parsed.searchParams.set('profile', routingProfile)
  }

  const query = parsed.searchParams.toString()
  return { method, pathname, path: `${pathname}${query ? `?${query}` : ''}` }
}

function assertEvaManagedLocalTerminalAllowed(managed) {
  if (managed) {
    throw new EvaBrokerError(
      'Terminal access is unavailable for this managed remote agent.',
      403,
      'managed-terminal-unavailable'
    )
  }
}

function assertEvaManagedLocalMutationAllowed(managed, capability = 'This local action') {
  if (managed) {
    throw new EvaBrokerError(
      `${String(capability || 'This local action')} is unavailable for this managed remote agent.`,
      403,
      'managed-local-mutation-unavailable'
    )
  }
}

function isEvaManagedGatewayMethodBlocked(value) {
  const method = String(value || '')
  return (
    EVA_MANAGED_HIDDEN_NOUS_GATEWAY_METHODS.has(method) ||
    EVA_MANAGED_BLOCKED_GATEWAY_PREFIXES.some(prefix => method.startsWith(prefix))
  )
}

function normalizeEvaManagedCommandName(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .split(/\s+/, 1)[0]
    .toLowerCase()
}

function evaManagedCliCommand(argv) {
  if (!Array.isArray(argv)) return ''

  let index = 0
  while (index < argv.length) {
    const value = String(argv[index] || '')
    if (value === '--profile' || value === '-p') {
      index += 2
      continue
    }
    if (value.startsWith('--profile=')) {
      index += 1
      continue
    }
    return value.startsWith('-') ? '' : normalizeEvaManagedCommandName(value)
  }
  return ''
}

function isEvaManagedGatewayRequestBlocked(methodValue, params = {}) {
  const method = String(methodValue || '')
  if (isEvaManagedGatewayMethodBlocked(method)) return true
  if (!params || typeof params !== 'object') return false

  let command = ''
  if (method === 'slash.exec') {
    command = normalizeEvaManagedCommandName(params.command)
  } else if (method === 'command.dispatch') {
    command = normalizeEvaManagedCommandName(params.name)
  } else if (method === 'cli.exec') {
    command = evaManagedCliCommand(params.argv)
  }

  return EVA_MANAGED_HIDDEN_NOUS_COMMANDS.has(command)
}

function normalizeDeviceCodeVerifier(value) {
  const verifier = String(value || '')
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new EvaBrokerError('evaOS Agent device code verifier is invalid.', 400, 'invalid-verifier')
  }
  return verifier
}

function makeEvaDesktopCodeVerifier(cryptoApi = crypto) {
  const bytes = Buffer.from(cryptoApi.randomBytes(32))
  if (bytes.length !== 32) {
    throw new Error('Could not create a valid evaOS Agent device code verifier.')
  }
  return normalizeDeviceCodeVerifier(bytes.toString('base64url'))
}

function evaDesktopCodeChallenge(verifier, cryptoApi = crypto) {
  return cryptoApi.createHash('sha256').update(normalizeDeviceCodeVerifier(verifier), 'ascii').digest('base64url')
}

function makeAuthState(cryptoApi = crypto) {
  return String(cryptoApi.randomUUID())
}

function buildEvaDesktopAuthUrl(codeChallenge, authState, policy = EVA_MANAGED_POLICY) {
  const challenge = String(codeChallenge || '')
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new Error('evaOS Agent desktop code challenge is invalid.')
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(authState || ''))) {
    throw new Error('evaOS Agent desktop auth state is invalid.')
  }

  const url = new URL(policy.dashboardAuthUrl)
  url.searchParams.set('desktop_app', '1')
  url.searchParams.set('callback_scheme', policy.callbackScheme)
  url.searchParams.set('desktop_auth_state', String(authState))
  url.searchParams.set('desktop_code_challenge', challenge)
  url.searchParams.set('desktop_code_challenge_method', 'S256')
  url.searchParams.set('switch_account', '1')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

function parseFutureTimestamp(value, label, now = Date.now()) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp) || timestamp <= now) {
    throw new EvaBrokerError(`${label} is missing or expired.`, 401, 'session-expired')
  }
  return new Date(timestamp).toISOString()
}

function normalizeOpaqueToken(value, label) {
  const token = String(value || '').trim()
  const hasWhitespaceOrControl = Array.from(token).some(character => {
    const codePoint = character.codePointAt(0)
    return character.trim().length === 0 || codePoint === undefined || codePoint <= 0x1f
  })
  if (!token || token.length > 4096 || hasWhitespaceOrControl) {
    throw new EvaBrokerError(`${label} is invalid.`, 401, 'invalid-session')
  }
  return token
}

function normalizeDesktopSession(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') {
    throw new EvaBrokerError('Electric Sheep sign-in returned an invalid session.', 401, 'invalid-session')
  }
  return {
    token: normalizeOpaqueToken(payload.desktop_session, 'Electric Sheep desktop session'),
    expiresAt: parseFutureTimestamp(
      payload.desktop_session_expires_at ?? payload.expires_at,
      'Electric Sheep desktop session',
      now
    ),
    email: typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim().slice(0, 320) : null
  }
}

function parseEvaDesktopAuthCallback(rawUrl, expectedState) {
  let url
  try {
    url = new URL(String(rawUrl || ''))
  } catch {
    throw new EvaBrokerError('evaOS Agent received an invalid sign-in callback.', 400, 'invalid-callback')
  }
  if (
    url.protocol !== `${EVA_MANAGED_POLICY.callbackScheme}:` ||
    url.hostname !== 'auth' ||
    url.pathname !== '/callback'
  ) {
    throw new EvaBrokerError('evaOS Agent received an unexpected sign-in callback.', 400, 'invalid-callback')
  }
  const callbackKeys = [...url.searchParams.keys()]
  if (
    callbackKeys.length !== 2 ||
    new Set(callbackKeys).size !== 2 ||
    !callbackKeys.includes('desktop_auth_state') ||
    !callbackKeys.includes('device_code')
  ) {
    throw new EvaBrokerError('evaOS Agent received an unexpected sign-in callback shape.', 400, 'invalid-callback')
  }
  if (!expectedState || url.searchParams.get('desktop_auth_state') !== expectedState) {
    throw new EvaBrokerError('evaOS Agent sign-in state did not match.', 400, 'state-mismatch')
  }
  if (url.searchParams.has('desktop_session') || url.searchParams.has('session_token')) {
    throw new EvaBrokerError('evaOS Agent sign-in callbacks may not carry session tokens.', 400, 'token-in-callback')
  }
  const deviceCode = String(url.searchParams.get('device_code') || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (deviceCode.length < 8 || deviceCode.length > 40) {
    throw new EvaBrokerError(
      'evaOS Agent sign-in callback did not contain a valid device code.',
      400,
      'invalid-callback'
    )
  }
  return { deviceCode }
}

function normalizeRemoteBaseUrl(value, policy = EVA_MANAGED_POLICY) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new EvaBrokerError('Electric Sheep returned an invalid managed backend.', 502, 'invalid-enrollment')
  }
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !hostname.endsWith(policy.runtimeHostSuffix) ||
    !/^hermes-[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(
      hostname.slice(0, -policy.runtimeHostSuffix.length)
    )
  ) {
    throw new EvaBrokerError('Electric Sheep returned an untrusted managed backend.', 502, 'invalid-enrollment')
  }
  return url.origin
}

function buildEvaManagedWsUrl(baseUrl, token) {
  const parsed = new URL(normalizeRemoteBaseUrl(baseUrl))
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')
  return `${scheme}://${parsed.host}${prefix}/api/ws?eva_session=${encodeURIComponent(
    normalizeOpaqueToken(token, 'evaOS Agent runtime session')
  )}`
}

function normalizeHermesEnrollment(payload, options = {}) {
  const policy = options.policy ?? EVA_MANAGED_POLICY
  const now = options.now ?? Date.now()
  if (!payload || typeof payload !== 'object' || payload.schema_version !== policy.enrollmentSchemaVersion) {
    throw new EvaBrokerError(
      'Electric Sheep returned an unsupported evaOS Agent enrollment.',
      502,
      'invalid-enrollment'
    )
  }
  const customerId = String(payload.customer_id || '').trim().toLowerCase()
  if (payload.runtime !== policy.runtime || !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(customerId)) {
    throw new EvaBrokerError('Electric Sheep returned an invalid managed account.', 403, 'wrong-customer')
  }

  const remote = payload.remote_backend
  if (!remote || typeof remote !== 'object') {
    throw new EvaBrokerError('Electric Sheep returned an incomplete evaOS Agent enrollment.', 502, 'invalid-enrollment')
  }
  const agentId = String(remote.agent_id || '').trim()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(agentId)) {
    throw new EvaBrokerError('Electric Sheep returned an invalid assigned agent.', 403, 'wrong-agent')
  }

  const rawDisplayName = typeof remote.agent_display_name === 'string' ? remote.agent_display_name.trim() : ''
  const agentDisplayName =
    rawDisplayName && rawDisplayName.length <= 120 && !hasAsciiControl(rawDisplayName) ? rawDisplayName : agentId

  const baseUrl = normalizeRemoteBaseUrl(remote.base_url, policy)
  const expectedOrigin = `https://hermes-${customerId}${policy.runtimeHostSuffix}`
  if (baseUrl !== expectedOrigin) {
    throw new EvaBrokerError('Electric Sheep returned a backend for a different managed account.', 403, 'wrong-customer')
  }

  return {
    schemaVersion: policy.enrollmentSchemaVersion,
    customerId,
    runtime: policy.runtime,
    agentId,
    agentDisplayName,
    baseUrl,
    token: normalizeOpaqueToken(remote.session_token, 'evaOS Agent runtime session'),
    expiresAt: parseFutureTimestamp(remote.expires_at, 'evaOS Agent runtime session', now)
  }
}

function normalizeSupportLabel(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 120 || hasAsciiControl(normalized)) {
    throw new EvaBrokerError(`Electric Sheep returned an invalid ${label}.`, 502, 'invalid-enrollment')
  }
  return normalized
}

function normalizeSupportEnrollment(payload, options = {}) {
  const now = options.now ?? Date.now()
  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.session_kind !== EVA_SUPPORT_SESSION_KIND
  ) {
    throw new EvaBrokerError('Electric Sheep returned a non-support enrollment.', 403, 'invalid-support-session')
  }

  const enrollment = normalizeHermesEnrollment(payload, options)
  const supportSessionId = normalizeOpaqueToken(
    payload.support_session_id,
    'Electric Sheep support session'
  )
  if (typeof payload.admin_bypass !== 'boolean') {
    throw new EvaBrokerError('Electric Sheep returned an invalid support admin proof.', 403, 'invalid-support-session')
  }
  const adminBypass = payload.admin_bypass
  let assignmentVersion
  if (adminBypass) {
    if (payload.assignment_version !== null) {
      throw new EvaBrokerError('Electric Sheep returned an invalid support assignment.', 403, 'invalid-support-session')
    }
    assignmentVersion = null
  } else {
    try {
      assignmentVersion = normalizeOpaqueToken(payload.assignment_version, 'Electric Sheep support assignment')
    } catch {
      throw new EvaBrokerError('Electric Sheep returned an invalid support assignment.', 403, 'invalid-support-session')
    }
  }
  if (assignmentVersion !== null && (assignmentVersion.length > 256 || hasAsciiControl(assignmentVersion))) {
    throw new EvaBrokerError('Electric Sheep returned an invalid support assignment.', 403, 'invalid-support-session')
  }

  const supportExpiresAt = parseFutureTimestamp(
    payload.support_expires_at,
    'Electric Sheep support session',
    now
  )
  if (Date.parse(supportExpiresAt) > now + EVA_SUPPORT_MAX_DURATION_MS) {
    throw new EvaBrokerError('Electric Sheep returned an unsafe support deadline.', 403, 'invalid-support-session')
  }

  const presentation = payload.presentation
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
    throw new EvaBrokerError('Electric Sheep returned no support presentation.', 502, 'invalid-enrollment')
  }
  const supportCustomerLabel = normalizeSupportLabel(
    presentation.customer_label ?? presentation.customer_display_name ?? presentation.client_label,
    'support customer label'
  )
  const supportAgentLabel = normalizeSupportLabel(
    presentation.agent_label,
    'support agent label'
  )
  const rawProfile = payload.profile
  const profile = rawProfile == null ? null : String(rawProfile).trim()
  if (profile === null || !EVA_MANAGED_PROFILE_RE.test(profile) || profile === 'all') {
    throw new EvaBrokerError('Electric Sheep returned an invalid support profile.', 403, 'invalid-support-session')
  }

  return {
    ...enrollment,
    sessionKind: EVA_SUPPORT_SESSION_KIND,
    supportSessionId,
    assignmentVersion,
    adminBypass,
    supportExpiresAt,
    supportDeadline: supportExpiresAt,
    supportCustomerLabel,
    supportAgentLabel,
    profile
  }
}

async function brokerPost(body, options = {}) {
  const policy = options.policy ?? EVA_MANAGED_POLICY
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new EvaBrokerError(
      'evaOS Agent cannot reach Electric Sheep from this runtime.',
      null,
      'transport-unavailable'
    )
  }

  let response
  let payload = null
  const requestController = new AbortController()
  const externalSignal = options.signal
  const abortFromExternal = () => requestController.abort(externalSignal?.reason)
  const timeoutMs = options.timeoutMs ?? policy.brokerRequestTimeoutMs
  const timeoutReason = new Error('eva broker request deadline exceeded')
  let abortListener
  const abortPromise = new Promise((_, reject) => {
    abortListener = () => reject(requestController.signal.reason ?? timeoutReason)
    requestController.signal.addEventListener('abort', abortListener, { once: true })
  })
  const timeout = setTimeout(() => requestController.abort(timeoutReason), timeoutMs)
  if (externalSignal?.aborted) {
    abortFromExternal()
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  }
  try {
    response = await Promise.race([
      fetchImpl(policy.brokerUrl, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: requestController.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Info': `evaos-agent/${EVA_DESKTOP_PACKAGE_VERSION}`,
          ...(options.desktopSession ? { Authorization: `Bearer ${options.desktopSession}` } : {})
        },
        body: JSON.stringify(body)
      }),
      abortPromise
    ])
    try {
      payload = await Promise.race([response.json(), abortPromise])
    } catch (error) {
      if (requestController.signal.aborted) throw error
      payload = null
    }
  } catch (error) {
    if (requestController.signal.aborted || error?.name === 'AbortError') {
      throw new EvaBrokerError('evaOS Agent sign-in timed out.', 408, 'timeout')
    }
    throw new EvaBrokerError('evaOS Agent could not reach Electric Sheep.', null, 'transport-error')
  } finally {
    clearTimeout(timeout)
    requestController.signal.removeEventListener('abort', abortListener)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }

  if (!response.ok) {
    const brokerCode = normalizeEvaManagedBrokerCode(payload?.code ?? payload?.error)
    // Backend prose may contain account, customer, route, or provider detail.
    // Surface only the bounded machine code and status that this client has
    // independently validated.
    const safeMessage = brokerCode
      ? `Electric Sheep request failed (${response.status}). [code: ${brokerCode}]`
      : `Electric Sheep request failed (${response.status}).`
    const error = new EvaBrokerError(safeMessage, response.status, brokerCode ?? 'broker-rejected')
    // Keep the polling/retry classification separate from the broker's
    // diagnostic code. A server-selected code must never accidentally look like
    // an internal state marker such as stale-auth.
    error.brokerRejected = true
    throw error
  }
  return payload
}

async function claimEvaDeviceCode(deviceCode, deviceCodeVerifier, options = {}) {
  const normalizedCode = String(deviceCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (normalizedCode.length < 8 || normalizedCode.length > 40) {
    throw new EvaBrokerError('evaOS Agent device code is invalid.', 400, 'invalid-device-code')
  }
  return normalizeDesktopSession(
    await brokerPost(
      {
        action: 'claim_desktop_device_code',
        device_code: normalizedCode,
        device_code_verifier: normalizeDeviceCodeVerifier(deviceCodeVerifier)
      },
      options
    ),
    options.now ?? Date.now()
  )
}

async function pollEvaDeviceCode(deviceCode, deviceCodeVerifier, options = {}) {
  const now = options.now ?? (() => Date.now())
  const sleep =
    options.sleep ??
    (delayMs =>
      new Promise(resolve => {
        setTimeout(resolve, delayMs)
      }))
  const policy = options.policy ?? EVA_MANAGED_POLICY
  const deadline = now() + (options.timeoutMs ?? policy.loginTimeoutMs)

  while (now() < deadline) {
    try {
      return await claimEvaDeviceCode(deviceCode, deviceCodeVerifier, { ...options, now: now() })
    } catch (error) {
      if (!(error instanceof EvaBrokerError) || error.statusCode !== 401 || error.brokerRejected !== true) {
        throw error
      }
    }
    await sleep(options.pollMs ?? policy.deviceCodePollMs)
  }
  throw new EvaBrokerError('evaOS Agent sign-in timed out.', 408, 'timeout')
}

async function launchEvaHermesRuntime(desktopSession, options = {}) {
  const policy = options.policy ?? EVA_MANAGED_POLICY
  const payload = await brokerPost(
    {
      action: 'runtime_launch',
      runtime: policy.runtime,
      launch_mode: policy.launchMode,
      client_surface: policy.clientSurface
    },
    { ...options, desktopSession: normalizeOpaqueToken(desktopSession, 'Electric Sheep desktop session') }
  )
  return normalizeHermesEnrollment(payload, options)
}

async function revokeEvaDesktopSession(desktopSession, options = {}) {
  try {
    await brokerPost(
      { action: 'revoke_desktop_session' },
      { ...options, desktopSession: normalizeOpaqueToken(desktopSession, 'Electric Sheep desktop session') }
    )
    return true
  } catch {
    return false
  }
}

function expiresSoon(expiresAt, skewMs = EVA_MANAGED_POLICY.runtimeRefreshSkewMs, now = Date.now()) {
  const timestamp = Date.parse(String(expiresAt || ''))
  return !Number.isFinite(timestamp) || timestamp <= now + skewMs
}

function publicEvaEnrollmentStatus(state, now = Date.now()) {
  const desktop = state?.desktop ?? null
  const runtime = state?.runtime ?? null
  const delegatedSupport =
    state?.delegatedSupport ?? (runtime?.sessionKind === EVA_SUPPORT_SESSION_KIND ? runtime : null)
  const delegatedSupportActive = Boolean(
    delegatedSupport && !expiresSoon(delegatedSupport.supportExpiresAt, 0, now)
  )
  const presentationRuntime = delegatedSupportActive ? delegatedSupport : runtime
  return {
    managed: true,
    productName: EVA_MANAGED_POLICY.productName,
    signedOut: state?.signedOut === true,
    customerId: delegatedSupportActive ? null : runtime?.customerId ?? null,
    email: desktop?.email ?? null,
    desktopSessionExpiresAt: desktop?.expiresAt ?? null,
    desktopSessionActive: Boolean(desktop && !expiresSoon(desktop.expiresAt, 0, now)),
    runtimeSessionExpiresAt: presentationRuntime?.expiresAt ?? null,
    runtimeSessionActive: Boolean(presentationRuntime && !expiresSoon(presentationRuntime.expiresAt, 0, now)),
    agentId: delegatedSupportActive ? null : runtime?.agentId ?? null,
    agentDisplayName: delegatedSupportActive
      ? delegatedSupport.supportAgentLabel
      : runtime?.agentDisplayName ?? runtime?.agentId ?? null,
    updateChannel: EVA_MANAGED_POLICY.updateChannel,
    delegatedSupportActive,
    sessionKind: delegatedSupportActive ? EVA_SUPPORT_SESSION_KIND : 'ordinary',
    supportCustomerLabel: delegatedSupportActive ? delegatedSupport.supportCustomerLabel : null,
    supportAgentLabel: delegatedSupportActive ? delegatedSupport.supportAgentLabel : null,
    supportExpiresAt: delegatedSupportActive ? delegatedSupport.supportExpiresAt : null,
    supportDeadline: delegatedSupportActive ? delegatedSupport.supportDeadline : null,
    assignmentVersion: delegatedSupportActive ? delegatedSupport.assignmentVersion : null,
    supportEndFailed: delegatedSupportActive && state?.supportEndError === true
  }
}

function resolveEvaManagedDesktopProfile(response) {
  const current = typeof response?.current === 'string' ? response.current.trim() : ''
  if (current === 'default' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(current)) {
    throw new EvaBrokerError('evaOS Agent could not verify its assigned profile.', 502, 'invalid-profile-scope')
  }
  return current
}

async function resolveEvaManagedDesktopProfileFromSources(readActiveProfile, readEnrollmentStatus) {
  try {
    return resolveEvaManagedDesktopProfile(await readActiveProfile())
  } catch (error) {
    if (Number(error?.statusCode) !== 404) {
      throw error
    }

    return resolveEvaManagedDesktopProfile({ current: readEnrollmentStatus()?.agentId })
  }
}

module.exports = {
  EVA_MANAGED_POLICY,
  EvaBrokerError,
  assertEvaManagedApiRequestAllowed,
  assertEvaManagedLocalMutationAllowed,
  assertEvaManagedLocalTerminalAllowed,
  brokerPost,
  buildEvaAccountRendererResetScript,
  buildEvaDesktopAuthUrl,
  buildEvaManagedWsUrl,
  claimEvaDeviceCode,
  evaDesktopCodeChallenge,
  expiresSoon,
  isEvaManagedGatewayMethodBlocked,
  isEvaManagedGatewayRequestBlocked,
  launchEvaHermesRuntime,
  makeAuthState,
  makeEvaDesktopCodeVerifier,
  normalizeDesktopSession,
  normalizeHermesEnrollment,
  normalizeSupportEnrollment,
  parseEvaDesktopAuthCallback,
  pollEvaDeviceCode,
  publicEvaEnrollmentStatus,
  resolveEvaManagedDesktopProfile,
  resolveEvaManagedDesktopProfileFromSources,
  revokeEvaDesktopSession
}
