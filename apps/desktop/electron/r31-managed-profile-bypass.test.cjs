
const assert = require('node:assert/strict')
const test = require('node:test')
const { createManagedBackendGate } = require('./managed-backend-gate.cjs')

function makeHarness({ managed }) {
  const events = {
    deleteChecks: [],
    managedResolves: [],
    migrations: 0,
    reaps: 0,
    routeResolves: 0,
    spawnCalls: 0
  }

  const managedBackend = async ({ profile } = {}) => {
    events.managedResolves.push(profile)
    return { mode: 'remote', profile, source: 'synthetic-managed' }
  }

  const gate = createManagedBackendGate({
    enabled: managed,
    resolveBackend: managedBackend
  })

  const upstreamStart = async () => {
    events.reaps += 1
    events.migrations += 1
    events.spawnCalls += 1
    return { mode: 'local', source: 'synthetic-upstream' }
  }

  const startHermes = () =>
    gate.start(
      () => managedBackend(),
      upstreamStart
    )

  const ensureBackend = profile =>
    gate.resolve(profile, async () => {
      events.deleteChecks.push(profile)
      events.routeResolves += 1
      return upstreamStart()
    })

  return { events, ensureBackend, startHermes }
}

test('managed boot and reconnect bypass upstream profile migration and local ownership machinery', async () => {
  const harness = makeHarness({ managed: true })

  await harness.startHermes()
  await harness.ensureBackend('managed-owner')
  await harness.ensureBackend('managed-owner')

  assert.deepEqual(harness.events.managedResolves, [undefined, 'managed-owner', 'managed-owner'])
  assert.equal(harness.events.deleteChecks.length, 0, 'managed resolution must bypass workstation profile gates')
  assert.equal(harness.events.routeResolves, 0, 'managed resolution must bypass workstation route selection')
  assert.equal(harness.events.reaps, 0, 'managed resolution must not reap workstation backends')
  assert.equal(harness.events.spawnCalls, 0, 'managed resolution must not spawn workstation backends')
  assert.equal(harness.events.migrations, 0, 'managed resolution must not migrate active-profile.json')
})

test('unmanaged boot keeps the upstream migration path available', async () => {
  const harness = makeHarness({ managed: false })

  const start = await harness.startHermes()
  const connection = await harness.ensureBackend('local-owner')

  assert.equal(start.source, 'synthetic-upstream')
  assert.equal(connection.source, 'synthetic-upstream')
  assert.deepEqual(harness.events.managedResolves, [])
  assert.deepEqual(harness.events.deleteChecks, ['local-owner'])
  assert.equal(harness.events.routeResolves, 1)
  assert.equal(harness.events.reaps, 2)
  assert.equal(harness.events.spawnCalls, 2)
  assert.equal(harness.events.migrations, 2)
})
