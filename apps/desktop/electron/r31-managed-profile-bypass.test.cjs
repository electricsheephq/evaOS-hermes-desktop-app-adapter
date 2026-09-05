const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const mainSource = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

function extractFunction(sourceFile, name) {
  let match = null

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  assert.ok(match, `main.ts must define ${name} as a function declaration`)

  return sourceFile.text.slice(match.getStart(sourceFile), match.getEnd())
}

function compileMainFunctions(source) {
  const sourceFile = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = [extractFunction(sourceFile, 'ensureBackend'), extractFunction(sourceFile, 'startHermes')]
  const compiled = ts.transpileModule(
    `${functions.join('\n\n')}\nmodule.exports = { ensureBackend, startHermes }`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      },
      fileName: 'r31-managed-profile-bypass.fixture.ts'
    }
  )

  assert.equal(compiled.diagnostics?.length ?? 0, 0, 'extracted Desktop fixture must transpile without diagnostics')

  return compiled.outputText
}

const compiledMainFunctions = compileMainFunctions(mainSource)

function makeHarness({ managed }) {
  const events = {
    deleteChecks: [],
    managedResolves: [],
    migrations: 0,
    reaps: 0,
    routeResolves: 0,
    spawnCalls: 0
  }

  const context = {
    EVA_MANAGED_BUILD: managed,
    BOOT_FAKE_ERROR: null,
    backendConnectionState: {
      getPromise: () => null,
      startAttempt: () => ({ id: 'synthetic-attempt' })
    },
    backendStartFailure: null,
    bootstrapFailure: null,
    clearTimeout,
    console,
    crypto: { randomBytes: () => ({ toString: () => 'synthetic' }) },
    evaManagedRuntime: {
      resolveBackend: async (input = {}) => {
        const { profile } = input
        events.managedResolves.push(profile)

        return { mode: 'remote', profile, source: 'synthetic-managed' }
      }
    },
    advanceBootProgress: async () => {},
    getWindowState: () => ({ window: 'synthetic' }),
    hermesLog: [],
    isPrimaryInstance: true,
    managedPrimaryRestoreOwners: new Set(),
    migrateActiveProfileIfMissing: () => {
      events.migrations += 1

      if (managed) {
        throw new Error('managed path called migrateActiveProfileIfMissing')
      }
    },
    primaryBackendIsRemote: () => false,
    remoteReauthFailure: null,
    primaryProfileKey: () => {
      if (!managed) {
        throw new Error('unmanaged fixture stopped after migration')
      }

      return 'synthetic'
    },
    profileDeletionGate: {
      assertCanStart: key => events.deleteChecks.push(key)
    },
    profileRouteOptions: () => ({ synthetic: true }),
    reapOrphanedBackendsOnce: async () => {
      events.reaps += 1

      if (managed) {
        throw new Error('managed path called reapOrphanedBackendsOnce')
      }
    },
    rememberLog: () => {},
    resolveProfileBackendRoute: () => {
      events.routeResolves += 1

      return { backend: 'primary' }
    },
    setActiveGatewayProfile: () => {},
    setTimeout,
    spawn: () => {
      events.spawnCalls += 1
      throw new Error('fixture reached workstation backend spawn')
    },
    updateBootProgress: () => {}
  }

  const module = { exports: {} }
  const sandbox = { ...context, module }
  vm.runInNewContext(compiledMainFunctions, sandbox, {
    filename: path.join(__dirname, 'main.ts')
  })

  return { events, functions: module.exports }
}

test('managed boot and reconnect bypass upstream profile migration and local ownership machinery', async () => {
  const harness = makeHarness({ managed: true })

  await assert.doesNotReject(
    async () => {
      await harness.functions.startHermes()
      await harness.functions.ensureBackend('managed-owner')
      await harness.functions.ensureBackend('managed-owner')
    },
    'managed boot and reconnect must resolve through evaManagedRuntime without entering startHermes'
  )

  assert.deepEqual(harness.events.managedResolves, [undefined, 'managed-owner', 'managed-owner'])
  assert.equal(harness.events.deleteChecks.length, 0, 'managed resolution must bypass workstation profile gates')
  assert.equal(harness.events.routeResolves, 0, 'managed resolution must bypass workstation route selection')
  assert.equal(harness.events.reaps, 0, 'managed resolution must not reap workstation backends')
  assert.equal(harness.events.spawnCalls, 0, 'managed resolution must not spawn workstation backends')
  assert.equal(harness.events.migrations, 0, 'managed resolution must not migrate active-profile.json')
})

test('unmanaged boot keeps the upstream migration path', async () => {
  const harness = makeHarness({ managed: false })

  await assert.rejects(
    () => harness.functions.ensureBackend('local-owner'),
    /unmanaged fixture stopped after migration/
  )

  assert.deepEqual(harness.events.managedResolves, [])
  assert.equal(harness.events.deleteChecks.length, 1)
  assert.equal(harness.events.routeResolves, 1)
  assert.equal(harness.events.reaps, 1)
  assert.equal(harness.events.spawnCalls, 0, 'unmanaged fixture stops before child spawn')
  assert.equal(harness.events.migrations, 1)
})
