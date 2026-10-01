const { EventEmitter } = require('node:events')

const EVA_APP_UPDATE_FEED =
  'https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/releases/latest/download/'
const EVA_APP_UPDATE_CHANNEL = 'latest'
const EVA_APP_UPDATE_BRANCH = 'managed-beta'
const SAFE_CHECK_FAILURE_MESSAGE = 'evaOS Agent could not check for updates. Try again.'
const SAFE_APPLY_FAILURE_MESSAGE = 'evaOS Agent could not install the update. Try again.'
const RESTART_TO_CHECK_MESSAGE = 'Restart evaOS Agent to check for updates.'
// Electron keeps every partition session for the life of the process, so a
// process gets a bounded number of fresh updater sessions; past that a failed
// check asks for a restart.
const MAX_UPDATER_NET_SESSIONS = 8
// latest-mac.yml `vendor` key written at build time from the renderer's
// REQUIRED_BACKEND_CONTRACT (scripts/backend-contract.mjs).
const EVA_MIN_BACKEND_CONTRACT_KEY = 'evaosMinBackendContract'
const AGENT_CONTRACT_HOLD_MESSAGES = Object.freeze({
  'waiting-for-agent': 'Waiting for your agent to connect.',
  'agent-update-required': 'Your agent needs an update before this app update.'
})
const MANAGED_RELEASE_NOTE_REPLACEMENTS = [
  [/Eva by Electric Sheep/g, 'evaOS Agent'],
  [/Hermes Desktop/g, 'evaOS Agent'],
  [/Hermes Agent/g, 'evaOS Agent'],
  [/Nous Portal/g, 'Electric Sheep account'],
  [/Nous Research/g, 'Electric Sheep'],
  [/\bHermes\b/g, 'evaOS Agent'],
  [/\bEva\b/g, 'evaOS Agent'],
  [/\bNous\b/g, 'Electric Sheep']
]

function normalizeVersion(info) {
  const value = String(info?.version || '').trim()
  return value || null
}

function sanitizeReleaseNote(summary) {
  return MANAGED_RELEASE_NOTE_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    String(summary || '')
  )
}

function releaseNoteCommits(info, now = Date.now) {
  const raw = Array.isArray(info?.releaseNotes)
    ? info.releaseNotes
        .map(item => item?.note)
        .filter(Boolean)
        .join('\n')
    : String(info?.releaseNotes || '')

  return raw
    .split('\n')
    .map(line => line.trim().replace(/^[-*]\s+/, ''))
    .filter(line => line && !line.startsWith('#'))
    .slice(0, 20)
    .map((summary, index) => ({
      sha: `release-note:${normalizeVersion(info) || 'unknown'}:${index + 1}`,
      summary: sanitizeReleaseNote(summary),
      author: 'Electric Sheep',
      at: now()
    }))
}

function statusFor(app, info, updateAvailable, now = Date.now) {
  const targetVersion = normalizeVersion(info)
  const commits = updateAvailable ? releaseNoteCommits(info, now) : []

  return {
    supported: true,
    updateAvailable,
    branch: EVA_APP_UPDATE_BRANCH,
    currentSha: `release:${app.getVersion()}`,
    targetSha: updateAvailable && targetVersion ? `release:${targetVersion}` : undefined,
    behind: updateAvailable ? Math.max(1, commits.length) : 0,
    commits: commits.length > 0 ? commits : undefined,
    message: updateAvailable && targetVersion ? `evaOS Agent ${targetVersion} is ready to install.` : undefined,
    fetchedAt: now()
  }
}

/**
 * Whether a release may be offered to this app given the lowest agent
 * contract it has seen. Returns null when it may, else the hold reason.
 * Releases without the field predate the gate and stay allowed.
 */
function agentContractHold(info, lowestAgentContract) {
  const raw = info?.vendor?.[EVA_MIN_BACKEND_CONTRACT_KEY]
  if (raw === undefined || raw === null) return null
  // Only a positive integer (or its digits) is a requirement; '', false or -1
  // must not read as 0.
  const required = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : NaN
  if (!Number.isInteger(lowestAgentContract)) return 'waiting-for-agent'
  // A malformed field fails closed: it cannot prove the agent is new enough.
  return Number.isInteger(required) && required > 0 && lowestAgentContract >= required ? null : 'agent-update-required'
}

function heldStatus(app, info, reason, now = Date.now) {
  return { ...statusFor(app, info, false, now), message: AGENT_CONTRACT_HOLD_MESSAGES[reason], reason }
}

/**
 * The lowest agent contract each connection reported in this run, kept in
 * memory only: a value saved by an earlier launch could release an update
 * before the agent reconnects (e.g. after a rollback), so each launch holds
 * until its agents report again. A later, higher report never raises a
 * connection's value: one managed connection serves every profile of the
 * account, and those profiles can run different runtimes. The gate uses the
 * lowest across connections; an agent upgraded mid-run releases the update at
 * the next launch.
 */
function createAgentContractStore() {
  const contracts = new Map()

  return Object.freeze({
    lowest() {
      return contracts.size > 0 ? Math.min(...contracts.values()) : null
    },
    /**
     * Records a connection's contract, keeping the lowest seen this run. null
     * (a backend without the field) is stored as 0 so it keeps holding
     * updates. Returns whether the connection's value changed.
     */
    record(connection, reported) {
      const key = String(connection || '').slice(0, 256)
      const contract = reported === null ? 0 : reported
      if (!key || !Number.isInteger(contract) || contract < 0) return false
      if (contracts.has(key) && contracts.get(key) <= contract) return false
      contracts.set(key, contract)
      return true
    }
  })
}

function unsupportedStatus(message, now = Date.now) {
  return {
    supported: false,
    branch: EVA_APP_UPDATE_BRANCH,
    message,
    fetchedAt: now()
  }
}

function safeCheckFailure(now = Date.now) {
  return {
    supported: true,
    branch: EVA_APP_UPDATE_BRANCH,
    error: 'check-failed',
    message: SAFE_CHECK_FAILURE_MESSAGE,
    fetchedAt: now()
  }
}

function restartToCheckFailure(now = Date.now) {
  return { ...safeCheckFailure(now), message: RESTART_TO_CHECK_MESSAGE }
}

function safeApplyFailure() {
  return {
    ok: false,
    error: 'apply-failed',
    message: SAFE_APPLY_FAILURE_MESSAGE
  }
}

function createEvaAppUpdater(options) {
  const {
    app,
    arch = process.arch,
    autoUpdater,
    emitProgress = () => undefined,
    getLowestAgentContract = () => null,
    // How many times the Network Service has restarted, and a fresh net
    // session for that count (main.ts). Optional: without them nothing swaps.
    getNetworkGeneration = () => 0,
    isPackaged = app?.isPackaged,
    netSessionFor = null,
    now = Date.now,
    onChecked = () => undefined,
    onError = () => undefined,
    platform = process.platform,
    prepareInstallHandoff = () => undefined,
    schedule = setTimeout
  } = options || {}

  if (!app || typeof app.getVersion !== 'function') {
    throw new Error('evaOS Agent updater requires an Electron app instance.')
  }

  if (!autoUpdater || !(autoUpdater instanceof EventEmitter) || typeof autoUpdater.setFeedURL !== 'function') {
    throw new Error('evaOS Agent updater requires electron-updater.')
  }

  let lastStatus = null
  let lastAvailableInfo = null
  let contractHold = null
  let downloadedVersion = null
  const originalIsUpdateSupported =
    typeof autoUpdater.isUpdateSupported === 'function' ? autoUpdater.isUpdateSupported : () => true
  let checkPromise = null
  let applyPromise = null
  let applying = false
  let downloading = false
  let netGeneration = 0
  let netSessionStale = false
  let netSessionsCreated = 0

  function supported() {
    return Boolean(isPackaged) && platform === 'darwin' && arch === 'arm64'
  }

  function unavailableMessage() {
    return Boolean(isPackaged) && platform === 'darwin' && arch !== 'arm64'
      ? 'Signed in-app updates require the Apple Silicon evaOS Agent app.'
      : 'Signed in-app updates are available in the installed macOS app.'
  }

  function configure() {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = true
    // electron-updater's channel setter enables allowDowngrade. Set the
    // channel first, then restore the product's forward-only invariant.
    autoUpdater.channel = EVA_APP_UPDATE_CHANNEL
    autoUpdater.allowDowngrade = false
    // The GitHub release CDN answers multi-range requests with 501, which
    // made every differential update fall back to the full zip (adapter#411).
    // Single-range requests are accepted, so the downloader sends one per run.
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: EVA_APP_UPDATE_FEED,
      channel: EVA_APP_UPDATE_CHANNEL,
      useMultipleRangeRequest: false
    })
    // Never offer an app update the connected agent runtime is too old for.
    autoUpdater.isUpdateSupported = async info => {
      if (!(await originalIsUpdateSupported(info))) return false
      contractHold = agentContractHold(info, getLowestAgentContract())
      return contractHold === null
    }
  }

  // After the Network Service restarts, Chromium net requests on an existing
  // session fail with net::ERR_FAILED until relaunch (electron/electron#35093),
  // and electron-updater keeps its session in httpExecutor.cachedSession. Each
  // restart gets a fresh partition, never in the middle of a download. When
  // the private field is missing, a failed check asks for a restart instead.
  function refreshNetSession() {
    const generation = Number(getNetworkGeneration()) || 0
    if (generation === netGeneration || downloading) return
    const executor = autoUpdater.httpExecutor
    if (
      typeof netSessionFor === 'function' &&
      executor &&
      'cachedSession' in executor &&
      netSessionsCreated < MAX_UPDATER_NET_SESSIONS
    ) {
      try {
        executor.cachedSession = netSessionFor(generation)
        netSessionsCreated += 1
        netGeneration = generation
        netSessionStale = false
        return
      } catch (error) {
        reportError('session', error)
      }
    }
    netSessionStale = true
  }

  function reportError(stage, error) {
    try {
      onError(stage, error)
    } catch {
      // Diagnostics must never replace the stable updater result.
    }
  }

  // One summary per successful check, so the log shows that checks work.
  function reportChecked(status, info) {
    try {
      onChecked({
        current: app.getVersion(),
        latest: normalizeVersion(info) || null,
        available: status?.updateAvailable === true,
        held: status?.reason || null
      })
    } catch {
      // Diagnostics must never replace the stable updater result.
    }
  }

  autoUpdater.on('update-available', info => {
    lastAvailableInfo = info
    lastStatus = statusFor(app, info, true, now)
  })

  autoUpdater.on('update-not-available', info => {
    lastStatus = contractHold ? heldStatus(app, info, contractHold, now) : statusFor(app, info, false, now)
  })

  autoUpdater.on('download-progress', progress => {
    if (!applying) {
      return
    }

    const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : null
    emitProgress({
      stage: 'fetch',
      message:
        percent === null ? 'Downloading the signed update…' : `Downloading the signed update… ${Math.round(percent)}%`,
      percent
    })
  })

  autoUpdater.on('update-downloaded', info => {
    downloadedVersion = normalizeVersion(info)
    if (!applying) {
      return
    }

    emitProgress({
      stage: 'restart',
      message: 'Installing the signed update and restarting evaOS Agent…',
      percent: 100
    })
  })

  autoUpdater.on('error', error => {
    if (!applying) {
      return
    }

    reportError('event', error)
    emitProgress({
      stage: 'error',
      message: SAFE_APPLY_FAILURE_MESSAGE,
      error: 'app-update-failed',
      percent: null
    })
  })

  async function check() {
    if (!supported()) {
      return unsupportedStatus(unavailableMessage(), now)
    }

    if (checkPromise) {
      return checkPromise
    }

    checkPromise = (async () => {
      try {
        configure()
        refreshNetSession()
        lastStatus = null
        contractHold = null
        const result = await autoUpdater.checkForUpdates()
        const info = result?.updateInfo
        if (!lastStatus) {
          const version = normalizeVersion(info)
          lastAvailableInfo = info
          lastStatus = contractHold
            ? heldStatus(app, info, contractHold, now)
            : statusFor(app, info, Boolean(version && version !== app.getVersion()), now)
        }
        reportChecked(lastStatus, info)
        return lastStatus
      } catch (error) {
        reportError('check', error)
        return netSessionStale ? restartToCheckFailure(now) : safeCheckFailure(now)
      } finally {
        checkPromise = null
      }
    })()

    return checkPromise
  }

  async function apply() {
    if (!supported()) {
      return {
        ok: false,
        error: 'unavailable',
        message: unavailableMessage()
      }
    }

    if (applyPromise) {
      return applyPromise
    }

    applyPromise = (async () => {
      applying = true
      try {
        configure()
        refreshNetSession()
        const status = lastStatus?.updateAvailable ? lastStatus : await check()
        if (!status?.updateAvailable) {
          return {
            ok: false,
            error: status?.error || 'no-update',
            message: status?.message || 'evaOS Agent is already up to date.'
          }
        }

        // The lowest agent contract can drop after the check (another agent
        // connects), so the gate is re-read before download and install.
        const heldApply = () => {
          const hold = agentContractHold(lastAvailableInfo, getLowestAgentContract())
          if (!hold) return null
          lastStatus = heldStatus(app, lastAvailableInfo, hold, now)
          return { ok: false, error: hold, message: lastStatus.message }
        }

        const heldBeforeDownload = heldApply()
        if (heldBeforeDownload) return heldBeforeDownload

        downloadedVersion = null
        emitProgress({ stage: 'fetch', message: 'Downloading the signed update…', percent: 0 })
        downloading = true
        try {
          await autoUpdater.downloadUpdate()
        } finally {
          downloading = false
        }

        if (!downloadedVersion) {
          throw new Error('The update downloaded without a verified release identity.')
        }

        const heldBeforeInstall = heldApply()
        if (heldBeforeInstall) return heldBeforeInstall

        const heldAtInstall = await new Promise((resolve, reject) => {
          schedule(() => {
            let rollbackHandoff
            try {
              // Re-read at the handoff itself: the contract can drop during the delay.
              const held = heldApply()
              if (held) {
                resolve(held)
                return
              }
              rollbackHandoff = prepareInstallHandoff()
              autoUpdater.quitAndInstall(false, true)
              resolve(null)
            } catch (error) {
              if (typeof rollbackHandoff === 'function') {
                rollbackHandoff()
              }
              reject(error)
            }
          }, 500)
        })
        if (heldAtInstall) return heldAtInstall
        return { ok: true, handedOff: true, message: `Installing evaOS Agent ${downloadedVersion}.` }
      } catch (error) {
        reportError('apply', error)
        emitProgress({
          stage: 'error',
          message: SAFE_APPLY_FAILURE_MESSAGE,
          error: 'app-update-failed',
          percent: null
        })
        return safeApplyFailure()
      } finally {
        applying = false
        applyPromise = null
      }
    })()

    return applyPromise
  }

  return Object.freeze({
    apply,
    check,
    feedUrl: EVA_APP_UPDATE_FEED
  })
}

module.exports = {
  EVA_APP_UPDATE_BRANCH,
  EVA_APP_UPDATE_CHANNEL,
  EVA_APP_UPDATE_FEED,
  EVA_MIN_BACKEND_CONTRACT_KEY,
  agentContractHold,
  createAgentContractStore,
  createEvaAppUpdater,
  releaseNoteCommits,
  safeApplyFailure,
  safeCheckFailure,
  sanitizeReleaseNote,
  statusFor,
  unsupportedStatus
}
