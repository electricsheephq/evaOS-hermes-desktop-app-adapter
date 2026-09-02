const assert = require('node:assert/strict')
const test = require('node:test')

const {
  EvaProtocolHandlerError,
  appBundlePath,
  createEvaProtocolHandlerManager
} = require('./eva-protocol-handler.cjs')

const CURRENT_APP = '/Applications/evaOS Agent.app'
const CURRENT_EXECUTABLE = `${CURRENT_APP}/Contents/MacOS/evaOS Agent`
const STALE_APP = '/Applications/.evaOS Agent.es12.pre-es13.app'
const BUNDLE_ID = 'com.electricsheephq.evaos.agent'

function fixture(overrides = {}) {
  let handlerPath = Object.hasOwn(overrides, 'handlerPath') ? overrides.handlerPath : CURRENT_APP
  const calls = []
  const manager = createEvaProtocolHandlerManager({
    scheme: 'evaos-agent',
    bundleIdentifier: BUNDLE_ID,
    platform: 'darwin',
    isPackaged: true,
    currentExecutablePath: CURRENT_EXECUTABLE,
    expectedInstallPath: CURRENT_APP,
    canonicalizeAppBundlePath: appBundlePath,
    registerProtocol: () => {
      calls.push(['register-protocol'])
      return overrides.registerProtocolResult ?? true
    },
    getApplicationInfoForProtocol: async url => {
      calls.push(['resolve', url])
      return handlerPath ? { path: handlerPath } : null
    },
    getApplicationNameForProtocol: () => (handlerPath ? 'evaOS Agent' : ''),
    readBundleIdentifier: async bundlePath => {
      calls.push(['read-bundle-id', bundlePath])
      if (overrides.readIdentifierError) throw overrides.readIdentifierError
      return overrides.handlerIdentifier ?? BUNDLE_ID
    },
    handlerBundleExists: async bundlePath => {
      calls.push(['bundle-exists', bundlePath])
      return overrides.handlerBundleExists !== false
    },
    registerBundle: async bundlePath => {
      calls.push(['register-bundle', bundlePath])
      if (overrides.forceRegistrationWins !== false) handlerPath = CURRENT_APP
    },
    unregisterBundle: async bundlePath => {
      calls.push(['unregister-bundle', bundlePath])
      if (overrides.unregisterChangesHandler !== false) handlerPath = null
    }
  })
  return { calls, manager }
}

test('appBundlePath returns the containing application for bundle and executable paths', () => {
  assert.equal(appBundlePath(CURRENT_APP), CURRENT_APP)
  assert.equal(appBundlePath(CURRENT_EXECUTABLE), CURRENT_APP)
  assert.equal(appBundlePath('/Applications/Eva.app.backup/Contents/MacOS/Eva'), null)
  assert.equal(appBundlePath('/usr/local/bin/eva'), null)
})

test('current installed handler is accepted without LaunchServices repair', async () => {
  const { calls, manager } = fixture()

  assert.deepEqual(await manager.ensureCurrentHandler(), { ok: true, repaired: false, skipped: false })
  assert.deepEqual(calls, [['resolve', 'evaos-agent://diagnostic/ping']])
})

test('a false protocol registration result fails closed while repairing a missing handler', async () => {
  const { calls, manager } = fixture({ handlerPath: null, registerProtocolResult: false })

  await assert.rejects(
    manager.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-handler-registration-failed'
  )
  assert.equal(
    calls.some(([name]) => name === 'unregister-bundle'),
    false
  )
})

test('a thrown protocol registration error is normalized during missing-handler repair', async () => {
  const manager = createEvaProtocolHandlerManager({
    scheme: 'evaos-agent',
    bundleIdentifier: BUNDLE_ID,
    platform: 'darwin',
    isPackaged: true,
    currentExecutablePath: CURRENT_EXECUTABLE,
    expectedInstallPath: CURRENT_APP,
    canonicalizeAppBundlePath: appBundlePath,
    registerProtocol: () => {
      throw new Error('native registration detail')
    },
    getApplicationInfoForProtocol: async () => null,
    registerBundle: async () => undefined
  })

  await assert.rejects(
    manager.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-handler-registration-failed'
  )
})

test('force-registering the current app repairs a stale handler when it takes ownership', async () => {
  const { calls, manager } = fixture({ handlerPath: STALE_APP })

  assert.deepEqual(await manager.ensureCurrentHandler(), { ok: true, repaired: true, skipped: false })
  assert.equal(
    calls.some(([name]) => name === 'unregister-bundle'),
    false
  )
  assert.deepEqual(calls.at(2), ['register-bundle', CURRENT_APP])
})

test('missing handler is repaired by registering the current installed app', async () => {
  const { calls, manager } = fixture({ handlerPath: null })

  assert.deepEqual(await manager.ensureCurrentHandler(), { ok: true, repaired: true, skipped: false })
  assert.deepEqual(calls.at(1), ['register-bundle', CURRENT_APP])
  assert.equal(
    calls.some(([name]) => name === 'unregister-bundle'),
    false
  )
})

test('a vanished stale handler bundle is treated as missing and repaired', async () => {
  const missingError = Object.assign(new Error('bundle no longer exists'), { code: 'ENOENT' })
  const { calls, manager } = fixture({
    handlerPath: STALE_APP,
    readIdentifierError: missingError,
    handlerBundleExists: false
  })

  assert.deepEqual(await manager.ensureCurrentHandler(), { ok: true, repaired: true, skipped: false })
  assert.deepEqual(calls.slice(0, 4), [
    ['resolve', 'evaos-agent://diagnostic/ping'],
    ['read-bundle-id', STALE_APP],
    ['bundle-exists', STALE_APP],
    ['register-bundle', CURRENT_APP]
  ])
  assert.equal(
    calls.some(([name]) => name === 'unregister-bundle'),
    false
  )
})

test('an unreadable existing handler remains untrusted and cannot authorize registration', async () => {
  const { calls, manager } = fixture({
    handlerPath: '/Applications/Other.app',
    readIdentifierError: new Error('permission denied')
  })

  await assert.rejects(
    manager.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-handler-untrusted'
  )
  assert.deepEqual(calls, [
    ['resolve', 'evaos-agent://diagnostic/ping'],
    ['read-bundle-id', '/Applications/Other.app'],
    ['bundle-exists', '/Applications/Other.app']
  ])
})

test('verified stale same-bundle handler is unregistered when force registration alone does not win', async () => {
  let handlerPath = STALE_APP
  const calls = []
  const manager = createEvaProtocolHandlerManager({
    scheme: 'evaos-agent',
    bundleIdentifier: BUNDLE_ID,
    platform: 'darwin',
    isPackaged: true,
    currentExecutablePath: CURRENT_EXECUTABLE,
    expectedInstallPath: CURRENT_APP,
    canonicalizeAppBundlePath: appBundlePath,
    registerProtocol: () => calls.push(['register-protocol']),
    getApplicationInfoForProtocol: async () => ({ path: handlerPath }),
    readBundleIdentifier: async bundlePath => {
      calls.push(['read-bundle-id', bundlePath])
      return BUNDLE_ID
    },
    registerBundle: async bundlePath => calls.push(['register-bundle', bundlePath]),
    unregisterBundle: async bundlePath => {
      calls.push(['unregister-bundle', bundlePath])
      handlerPath = CURRENT_APP
    }
  })

  assert.deepEqual(await manager.ensureCurrentHandler(), { ok: true, repaired: true, skipped: false })
  assert.deepEqual(
    calls.filter(([name]) => name === 'unregister-bundle'),
    [['unregister-bundle', STALE_APP]]
  )
})

test('unrelated handler is never unregistered and fails closed', async () => {
  const { calls, manager } = fixture({
    handlerPath: '/Applications/Other.app',
    handlerIdentifier: 'example.other',
    forceRegistrationWins: false
  })

  await assert.rejects(
    manager.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-handler-untrusted'
  )
  assert.equal(
    calls.some(([name]) => name === 'unregister-bundle'),
    false
  )
  assert.equal(
    calls.some(([name]) => name === 'register-bundle' || name === 'register-protocol'),
    false
  )
  assert.deepEqual(calls.slice(0, 2), [
    ['resolve', 'evaos-agent://diagnostic/ping'],
    ['read-bundle-id', '/Applications/Other.app']
  ])
})

test('an indeterminate handler lookup cannot authorize registration over an existing named handler', async () => {
  const calls = []
  const manager = createEvaProtocolHandlerManager({
    scheme: 'evaos-agent',
    bundleIdentifier: BUNDLE_ID,
    platform: 'darwin',
    isPackaged: true,
    currentExecutablePath: CURRENT_EXECUTABLE,
    expectedInstallPath: CURRENT_APP,
    canonicalizeAppBundlePath: appBundlePath,
    registerProtocol: () => calls.push(['register-protocol']),
    getApplicationInfoForProtocol: async () => {
      calls.push(['resolve'])
      throw new Error('lookup unavailable')
    },
    getApplicationNameForProtocol: () => {
      calls.push(['resolve-name'])
      return 'Other'
    },
    registerBundle: async bundlePath => calls.push(['register-bundle', bundlePath])
  })

  await assert.rejects(
    manager.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-handler-repair-failed'
  )
  assert.deepEqual(calls, [['resolve'], ['resolve-name']])
})

test('a rejected detail lookup plus an empty handler name is treated as a missing handler', async () => {
  let handlerPath = null
  const calls = []
  const manager = createEvaProtocolHandlerManager({
    scheme: 'evaos-agent',
    bundleIdentifier: BUNDLE_ID,
    platform: 'darwin',
    isPackaged: true,
    currentExecutablePath: CURRENT_EXECUTABLE,
    expectedInstallPath: CURRENT_APP,
    canonicalizeAppBundlePath: appBundlePath,
    registerProtocol: () => calls.push(['register-protocol']),
    getApplicationInfoForProtocol: async () => {
      calls.push(['resolve'])
      if (!handlerPath) throw new Error('no handler')
      return { path: handlerPath }
    },
    getApplicationNameForProtocol: () => {
      calls.push(['resolve-name'])
      return ''
    },
    registerBundle: async bundlePath => {
      calls.push(['register-bundle', bundlePath])
      handlerPath = CURRENT_APP
    }
  })

  assert.deepEqual(await manager.ensureCurrentHandler(), { ok: true, repaired: true, skipped: false })
  assert.deepEqual(calls, [
    ['resolve'],
    ['resolve-name'],
    ['register-bundle', CURRENT_APP],
    ['register-protocol'],
    ['resolve']
  ])
})

test('post-repair mismatch reports failure without deleting or moving applications', async () => {
  const { calls, manager } = fixture({
    handlerPath: STALE_APP,
    forceRegistrationWins: false,
    unregisterChangesHandler: false
  })

  await assert.rejects(
    manager.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-handler-repair-failed'
  )
  assert.deepEqual(
    calls.filter(([name]) => name === 'unregister-bundle'),
    [['unregister-bundle', STALE_APP]]
  )
})

test('LaunchServices command failure is normalized and fails closed', async () => {
  const failing = createEvaProtocolHandlerManager({
    scheme: 'evaos-agent',
    bundleIdentifier: BUNDLE_ID,
    platform: 'darwin',
    isPackaged: true,
    currentExecutablePath: CURRENT_EXECUTABLE,
    expectedInstallPath: CURRENT_APP,
    canonicalizeAppBundlePath: appBundlePath,
    registerProtocol: () => true,
    getApplicationInfoForProtocol: async () => ({ path: STALE_APP }),
    readBundleIdentifier: async () => BUNDLE_ID,
    registerBundle: async () => {
      throw new Error('command detail must not escape')
    }
  })

  await assert.rejects(
    failing.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-handler-registration-failed'
  )
})

test('packaged macOS app outside canonical Applications path cannot claim the managed scheme', async () => {
  const calls = []
  const noncanonical = createEvaProtocolHandlerManager({
    scheme: 'evaos-agent',
    bundleIdentifier: BUNDLE_ID,
    platform: 'darwin',
    isPackaged: true,
    currentExecutablePath: '/Users/operator/Downloads/evaOS Agent.app/Contents/MacOS/evaOS Agent',
    expectedInstallPath: CURRENT_APP,
    canonicalizeAppBundlePath: appBundlePath,
    registerProtocol: () => calls.push(['register-protocol']),
    getApplicationInfoForProtocol: async () => ({ path: CURRENT_APP })
  })

  await assert.rejects(
    noncanonical.ensureCurrentHandler(),
    error => error instanceof EvaProtocolHandlerError && error.code === 'callback-noncanonical-install'
  )
  assert.deepEqual(calls, [])
})

test('development and non-macOS builds preserve registration without LaunchServices mutation', async () => {
  for (const input of [
    { platform: 'linux', isPackaged: true },
    { platform: 'darwin', isPackaged: false }
  ]) {
    let registered = 0
    const manager = createEvaProtocolHandlerManager({
      scheme: 'evaos-agent',
      bundleIdentifier: BUNDLE_ID,
      currentExecutablePath: CURRENT_EXECUTABLE,
      expectedInstallPath: CURRENT_APP,
      registerProtocol: () => {
        registered += 1
      },
      getApplicationInfoForProtocol: async () => {
        throw new Error('must not resolve')
      },
      ...input
    })

    assert.deepEqual(await manager.ensureCurrentHandler(), { ok: true, repaired: false, skipped: true })
    assert.equal(registered, 1)
  }
})
