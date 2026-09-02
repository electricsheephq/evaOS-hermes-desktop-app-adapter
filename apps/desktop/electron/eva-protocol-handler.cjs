const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const OSASCRIPT_PATH = '/usr/bin/osascript'
const PLUTIL_PATH = '/usr/bin/plutil'
const RESOLVE_PROTOCOL_HANDLER_JXA = [
  'ObjC.import("AppKit")',
  'const args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments)',
  'const target = $.NSURL.URLWithString(args[args.length - 1])',
  'const owner = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(target)',
  'owner ? ObjC.unwrap(owner.path) : ""'
].join('; ')

class EvaProtocolHandlerError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EvaProtocolHandlerError'
    this.code = code
  }
}

function appBundlePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const absolute = path.resolve(value.trim())
  const parts = absolute.split(path.sep)
  const appIndex = parts.findIndex((part, index) => index > 0 && part.toLowerCase().endsWith('.app'))
  if (appIndex < 0) return null
  return path.join(path.parse(absolute).root, ...parts.slice(1, appIndex + 1))
}

function canonicalAppBundlePath(value, realpath = fs.realpathSync.native) {
  const bundle = appBundlePath(value)
  if (!bundle) return null
  try {
    return realpath(bundle)
  } catch {
    return path.resolve(bundle)
  }
}

async function readBundleIdentifier(bundlePath) {
  const infoPath = path.join(bundlePath, 'Contents', 'Info.plist')
  const { stdout } = await execFileAsync(PLUTIL_PATH, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024,
    timeout: 5_000
  })
  return stdout.trim()
}

async function runLaunchServices(args) {
  await execFileAsync(LSREGISTER_PATH, args, { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 10_000 })
}

async function resolveProtocolHandlerAppPath(protocolUrl, execute = execFileAsync) {
  const { stdout } = await execute(
    OSASCRIPT_PATH,
    ['-l', 'JavaScript', '-e', RESOLVE_PROTOCOL_HANDLER_JXA, '--', protocolUrl],
    { encoding: 'utf8', maxBuffer: 16 * 1024, timeout: 5_000 }
  )
  return stdout.trim() || null
}

async function bundleExists(bundlePath) {
  try {
    await fs.promises.stat(bundlePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

function protocolError(code) {
  return new EvaProtocolHandlerError(
    `evaOS Agent cannot receive sign-in links from this installation. Install it in Applications, archive older copies, and try again. [code: ${code}]`,
    code
  )
}

function createEvaProtocolHandlerManager(options) {
  if (
    !options?.scheme ||
    !options?.bundleIdentifier ||
    typeof options.registerProtocol !== 'function'
  ) {
    throw new TypeError('evaOS Agent protocol handling requires scheme, bundle identity, and Electron callbacks.')
  }

  const platform = options.platform ?? process.platform
  const isPackaged = options.isPackaged === true
  const currentExecutablePath = options.currentExecutablePath ?? process.execPath
  const expectedInstallPath = options.expectedInstallPath ?? '/Applications/evaOS Agent.app'
  const canonicalize = options.canonicalizeAppBundlePath ?? canonicalAppBundlePath
  const readIdentifier = options.readBundleIdentifier ?? readBundleIdentifier
  const handlerBundleExists = options.handlerBundleExists ?? bundleExists
  const registerBundle = options.registerBundle ?? (bundlePath => runLaunchServices(['-f', bundlePath]))
  const unregisterBundle = options.unregisterBundle ?? (bundlePath => runLaunchServices(['-u', bundlePath]))
  const resolveProtocolHandler = options.resolveProtocolHandlerAppPath ?? resolveProtocolHandlerAppPath
  const protocolUrl = `${options.scheme}://diagnostic/ping`
  let ensurePromise = null

  async function resolveOwnership(currentBundle) {
    let handlerPath
    try {
      handlerPath = await resolveProtocolHandler(protocolUrl)
    } catch {
      return { handlerBundle: null, lookupFailed: true, owned: false }
    }
    const handlerBundle = canonicalize(handlerPath)
    return { handlerBundle, lookupFailed: false, owned: Boolean(handlerBundle && handlerBundle === currentBundle) }
  }

  async function attemptCurrentRegistration(currentBundle) {
    try {
      await registerBundle(currentBundle)
      const registrationAccepted = options.registerProtocol() !== false
      return { ...(await resolveOwnership(currentBundle)), registrationAccepted }
    } catch {
      throw protocolError('callback-handler-registration-failed')
    }
  }

  async function ensureCurrentHandler({ repair = true } = {}) {
    if (ensurePromise) return ensurePromise

    const task = (async () => {
      if (platform !== 'darwin' || !isPackaged) {
        options.registerProtocol()
        return { ok: true, repaired: false, skipped: true }
      }

      const currentBundle = canonicalize(currentExecutablePath)
      const canonicalInstall = canonicalize(expectedInstallPath)
      if (!currentBundle || !canonicalInstall || currentBundle !== canonicalInstall) {
        throw protocolError('callback-noncanonical-install')
      }

      let ownership = await resolveOwnership(currentBundle)
      if (ownership.lookupFailed) throw protocolError('callback-handler-repair-failed')
      if (ownership.owned) return { ok: true, repaired: false, skipped: false }
      if (!repair) {
        throw protocolError('callback-handler-mismatch')
      }

      if (ownership.handlerBundle) {
        let handlerIdentifier
        try {
          handlerIdentifier = await readIdentifier(ownership.handlerBundle)
        } catch {
          let exists
          try {
            exists = await handlerBundleExists(ownership.handlerBundle)
          } catch {
            throw protocolError('callback-handler-untrusted')
          }
          if (exists !== false) throw protocolError('callback-handler-untrusted')
          ownership = { ...ownership, handlerBundle: null }
        }
        if (ownership.handlerBundle && handlerIdentifier !== options.bundleIdentifier) {
          throw protocolError('callback-handler-untrusted')
        }
      }

      if (ownership.handlerBundle) {
        try {
          await unregisterBundle(ownership.handlerBundle)
        } catch {
          throw protocolError('callback-handler-repair-failed')
        }
      }

      ownership = await attemptCurrentRegistration(currentBundle)
      if (ownership.lookupFailed) throw protocolError('callback-handler-repair-failed')
      if (ownership.owned && ownership.registrationAccepted) {
        return { ok: true, repaired: true, skipped: false }
      }

      if (ownership.owned && !ownership.registrationAccepted) {
        throw protocolError('callback-handler-registration-failed')
      }

      if (!ownership.handlerBundle || ownership.handlerBundle === currentBundle) {
        throw protocolError('callback-handler-repair-failed')
      }

      let remainingHandlerIdentifier
      try {
        remainingHandlerIdentifier = await readIdentifier(ownership.handlerBundle)
      } catch {
        throw protocolError('callback-handler-untrusted')
      }
      if (remainingHandlerIdentifier !== options.bundleIdentifier) {
        throw protocolError('callback-handler-untrusted')
      }
      throw protocolError('callback-handler-repair-failed')
    })()

    ensurePromise = task
    try {
      return await task
    } finally {
      if (ensurePromise === task) ensurePromise = null
    }
  }

  return { ensureCurrentHandler }
}

module.exports = {
  EvaProtocolHandlerError,
  appBundlePath,
  canonicalAppBundlePath,
  createEvaProtocolHandlerManager,
  resolveProtocolHandlerAppPath
}
