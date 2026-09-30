import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { BackendDialClaims } from './backend-dial-claim'
import { backendScopeKey, migrateV1ToRegistry } from './connection-registry'
import {
  createDesktopProfilePreferences,
  type DesktopProfileRoute,
  dialDesktopProfileRoute,
  resolveDesktopConnectionRequest,
  resolveDesktopWindowLaunch,
  resolveDesktopWindowRoute
} from './desktop-profile'
import { EVA_MANAGED_CONNECTION_ID, normalizeEvaManagedActiveRoute } from './plugin-profile-routes'
import { WindowConnectionRouteRegistry } from './window-connection-route'

test('failed authoritative writes leave the previous default and listeners untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-profile-write-'))
  const target = path.join(root, 'active-profile.json')
  const changes: unknown[] = []

  const preferences = createDesktopProfilePreferences(target, {
    onDefaultChanged: route => changes.push(route),
    validateRoute: route => {
      if (route.connectionId === 'missing') {
        throw new Error('Connection was removed')
      }
    }
  })

  try {
    const original = { connectionId: null, profile: 'work' }
    preferences.setDefault(original)

    for (const invalid of [
      null,
      {},
      { connectionId: 'missing', profile: 'work' },
      { connectionId: null, profile: ' work ' }
    ]) {
      assert.throws(() => preferences.setDefault(invalid))
      assert.deepEqual(preferences.getDefault(), original)
    }

    fs.mkdirSync(`${target}.tmp`)
    assert.throws(() => preferences.setDefault({ connectionId: 'remote', profile: 'personal' }))
    assert.deepEqual(preferences.getDefault(), original)
    assert.deepEqual(changes, [original])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('explicit routes are strict and never fall back to a different source window', () => {
  const routes = new WindowConnectionRouteRegistry()
  routes.set(1, { connectionId: 'remote-a', profile: 'work', registryScoped: true })
  routes.set(2, { connectionId: 'remote-b', profile: 'work', registryScoped: true })
  const fallback = { connectionId: null, profile: 'default' }
  const explicit = { connectionId: 'remote-c', profile: 'personal' }

  assert.deepEqual(resolveDesktopWindowRoute(undefined, routes.get(1), fallback), {
    connectionId: 'remote-a',
    profile: 'work'
  })
  assert.deepEqual(resolveDesktopWindowRoute(explicit, routes.get(1), fallback), explicit)
  assert.deepEqual(resolveDesktopWindowRoute(undefined, routes.get(2), fallback), {
    connectionId: 'remote-b',
    profile: 'work'
  })
  assert.deepEqual(resolveDesktopWindowRoute(undefined, routes.get(1), fallback), {
    connectionId: 'remote-a',
    profile: 'work'
  })
  // Only an explicit route pins the window's New-session default; an inherited
  // or fallback route seeds boot alone.
  assert.deepEqual(resolveDesktopWindowLaunch(explicit, routes.get(1), fallback), { ...explicit, profileWindow: true })
  assert.deepEqual(resolveDesktopWindowLaunch(undefined, routes.get(1), fallback), {
    connectionId: 'remote-a',
    profile: 'work',
    profileWindow: false
  })
  assert.deepEqual(resolveDesktopWindowLaunch(undefined, null, fallback), { ...fallback, profileWindow: false })
  assert.deepEqual(routes.get(1), { connectionId: 'remote-a', profile: 'work', registryScoped: true })
  assert.throws(() => resolveDesktopWindowRoute({ profile: 'work' }, routes.get(1), fallback))
  assert.throws(() => resolveDesktopWindowRoute({ connectionId: null, profile: '../work' }, routes.get(1), fallback))
  assert.throws(() => resolveDesktopWindowRoute({ connectionId: '', profile: 'work' }, routes.get(1), fallback))
})

test('boot and reconnect retain the window route rather than a later global default or another window', () => {
  const routeA = { connectionId: 'remote-a', profile: 'work', registryScoped: true }
  const routeB = { connectionId: null, profile: 'personal', registryScoped: false }

  for (const route of [routeA, routeB, routeA]) {
    assert.deepEqual(resolveDesktopConnectionRequest(undefined, route, 'last-used'), {
      connectionId: route.connectionId,
      profile: route.profile
    })
    assert.deepEqual(resolveDesktopConnectionRequest(route.profile, route, 'last-used'), {
      connectionId: null,
      profile: route.profile
    })
  }

  assert.deepEqual(resolveDesktopConnectionRequest('other', routeA, 'last-used'), {
    connectionId: null,
    profile: 'other'
  })
  assert.deepEqual(resolveDesktopConnectionRequest(undefined, null, 'last-used'), {
    connectionId: null,
    profile: 'last-used'
  })
})

test('an explicit default survives last-used profile writes and app restarts, isolated by desktop home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-profile-'))

  try {
    const homeA = path.join(root, 'a', 'active-profile.json')
    const homeB = path.join(root, 'b', 'active-profile.json')
    const changes: unknown[] = []
    const a = createDesktopProfilePreferences(homeA, { onDefaultChanged: route => changes.push(route) })
    const b = createDesktopProfilePreferences(homeB)
    const route = { connectionId: 'remote-work', profile: 'work' }

    assert.equal(a.getDefault(), null)
    assert.equal(a.remember('personal'), 'personal')
    assert.deepEqual(a.setDefault(route), route)
    a.remember('other')
    b.setDefault({ connectionId: null, profile: 'personal' })

    assert.equal(a.readActive(), 'other')
    assert.deepEqual(createDesktopProfilePreferences(homeA).getDefault(), route)
    assert.deepEqual(b.getDefault(), { connectionId: null, profile: 'personal' })
    assert.deepEqual(a.getDefault(), route)
    assert.deepEqual(changes, [route])
    a.afterProfileRequest(
      'remote-work',
      { method: 'PATCH', path: '/api/profiles/work', body: { new_name: 'ignored' } },
      { ok: false },
      'remote'
    )
    assert.deepEqual(a.getDefault(), route)
    a.afterProfileRequest(
      'remote-work',
      { method: 'PATCH', path: '/api/profiles/work', body: { new_name: 'renamed' } },
      { ok: true },
      'remote'
    )
    assert.deepEqual(a.getDefault(), { ...route, profile: 'renamed' })
    a.afterProfileRequest('remote-work', { method: 'DELETE', path: '/api/profiles/renamed' }, { ok: true }, 'remote')
    assert.equal(a.getDefault(), null)
    a.setDefault(route)
    a.profileChanged('another-source', 'work', 'renamed', 'remote')
    assert.deepEqual(a.getDefault(), route)
    a.profileChanged(route.connectionId, route.profile, 'renamed', 'remote')
    assert.deepEqual(a.getDefault(), { ...route, profile: 'renamed' })
    a.profileChanged(route.connectionId, 'renamed', null, 'remote')
    assert.equal(a.getDefault(), null)
    a.setDefault(route)
    a.connectionRemoved(route.connectionId)
    assert.equal(createDesktopProfilePreferences(homeA).getDefault(), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test.each([null, 'local'])(
  'successful local profile changes through %s retarget the saved startup profile',
  connectionId => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-profile-change-'))
    const target = path.join(root, 'active-profile.json')
    const preferences = createDesktopProfilePreferences(target)

    try {
      const defaultRoute = { connectionId: 'remote-work', profile: 'local-old' }
      preferences.setDefault(defaultRoute)
      preferences.remember('local-old')
      preferences.afterProfileRequest(
        connectionId,
        { method: 'DELETE', path: '/api/profiles/local-old' },
        { ok: false },
        'local'
      )
      assert.equal(preferences.readActive(), 'local-old')

      preferences.afterProfileRequest(
        'remote-work',
        { method: 'DELETE', path: '/api/profiles/local-old' },
        { ok: true },
        'remote'
      )
      assert.equal(preferences.readActive(), 'local-old')
      preferences.setDefault(defaultRoute)

      preferences.afterProfileRequest(
        connectionId,
        { method: 'PATCH', path: '/api/profiles/local-old', body: { new_name: 'local-new' } },
        { ok: true },
        'local'
      )
      const restarted = createDesktopProfilePreferences(target)
      assert.equal(restarted.readActive(), 'local-new')
      assert.deepEqual(restarted.getDefault(), defaultRoute)

      restarted.afterProfileRequest(
        connectionId,
        { method: 'DELETE', path: '/api/profiles/local-new' },
        { ok: true },
        'local'
      )
      assert.equal(createDesktopProfilePreferences(target).readActive(), 'default')
      assert.deepEqual(restarted.getDefault(), defaultRoute)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)

// `hermes:connection` in main.ts: the window route recorded by
// recordWindowConnectionRoute, resolved like the IPC handler, dialed through
// connectDesktopProfileRoute's real claim. Only the two backends are fakes;
// the registry one looks the id up exactly as ensureRegistryBackend does
// against a fresh workstation connections.json. `hold` parks ensureBackend
// until released, so concurrent dials can meet inside one claim.
function hermesConnectionHarness(managed: boolean, savedConnectionIds: string[] = []) {
  const routes = new WindowConnectionRouteRegistry()
  const registry = migrateV1ToRegistry({})
  const known = new Set([...registry.connections.map(c => c.id), ...savedConnectionIds])
  const dialClaims = new BackendDialClaims()
  const dials: string[] = []
  const claims: string[] = []
  let held: null | Promise<void> = null
  let release = () => undefined as void

  return {
    claims,
    dials,
    hold() {
      held = new Promise<void>(resolve => {
        release = resolve
      })
    },
    release: () => release(),
    recordWindowConnectionRoute(id: number, route: unknown) {
      routes.set(id, managed ? normalizeEvaManagedActiveRoute(route) : route)
    },
    getConnection(id: number, profile?: string) {
      const route: DesktopProfileRoute = resolveDesktopConnectionRequest(profile, routes.get(id), 'default')

      return dialDesktopProfileRoute(route, 'foreground', {
        applySpawnPriority: () => () => undefined,
        backendScopeKey,
        ensureBackend: async dialed => {
          dials.push(`backend:${dialed}`)
          await held

          return { profile: dialed }
        },
        ensureRegistryBackend: async connectionId => {
          const id = String(connectionId || '').trim() || registry.primary

          if (!known.has(id)) {
            throw new Error(`No connection with id "${id}".`)
          }

          dials.push(`registry:${id}`)

          return { profile: id }
        },
        managed,
        runDialClaim: (scopeKey, dial) => {
          claims.push(scopeKey)

          return dialClaims.run(scopeKey, dial)
        }
      })
    }
  }
}

test('a managed profile-less reconnect dials the managed backend, coalescing with boot (#388)', async () => {
  const app = hermesConnectionHarness(true)
  app.recordWindowConnectionRoute(1, {
    connectionId: EVA_MANAGED_CONNECTION_ID,
    profile: 'e-test',
    registryScoped: true
  })

  // Boot passes the profile explicitly; reconnect after sleep/wake passes none.
  assert.deepEqual(await app.getConnection(1, 'e-test'), { profile: 'e-test' })
  assert.deepEqual(await app.getConnection(1), { profile: 'e-test' })
  assert.deepEqual(app.dials, ['backend:e-test', 'backend:e-test'])
  assert.deepEqual(app.claims, ['e-test', 'e-test'])
})

test('a concurrent managed boot and reconnect share one managed dial (#388)', async () => {
  const app = hermesConnectionHarness(true)
  app.recordWindowConnectionRoute(1, {
    connectionId: EVA_MANAGED_CONNECTION_ID,
    profile: 'e-test',
    registryScoped: true
  })
  app.hold()

  const boot = app.getConnection(1, 'e-test')
  const reconnect = app.getConnection(1)
  app.release()
  const [booted, reconnected] = await Promise.all([boot, reconnect])

  assert.deepEqual(app.dials, ['backend:e-test'])
  assert.equal(reconnected, booted)
})

test('an upstream profile-less reconnect still dials its registry connection', async () => {
  const app = hermesConnectionHarness(false, ['remote-a'])
  app.recordWindowConnectionRoute(1, { connectionId: 'remote-a', profile: 'research', registryScoped: true })

  assert.deepEqual(await app.getConnection(1, 'research'), { profile: 'research' })
  assert.deepEqual(await app.getConnection(1), { profile: 'remote-a' })
  assert.deepEqual(app.dials, ['backend:research', 'registry:remote-a'])
  assert.deepEqual(app.claims, ['research', 'conn:remote-a::research'])
})
