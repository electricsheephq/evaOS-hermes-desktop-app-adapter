const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { EvaBrokerError, brokerPost } = require('./eva-managed.cjs')
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
        customer_id: 'customer-one',
        runtime: 'hermes'
      }
    })
  )
}

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
