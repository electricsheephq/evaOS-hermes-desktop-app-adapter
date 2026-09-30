/**
 * Mac bridge: this Mac's CUA, served to the user's own agents.
 *
 * When the user turns Computer Use on, main starts a PRIVATE cua-driver daemon
 * (its own socket, launched through CuaDriver.app so macOS permissions stay with
 * `com.trycua.driver`) and opens one outbound WebSocket to the signed-in user's
 * own agent's `computer-use` gateway plugin. The gateway asks for a
 * connection (`open`), and each one gets its own `cua-driver mcp` child, so every
 * agent (Desktop chat, Telegram, cron) has its own CUA session and they run in
 * parallel. JSON-RPC passes through untouched: the switch is the user's on/off,
 * not a gate, and nothing here narrows what CUA can do. Never during delegated
 * support: an admin's Mac is never offered to a customer's agents. The switch
 * belongs to the account that turned it on: another account signed in on this
 * Mac dials nothing.
 *
 * Frames (JSON text): Mac→gw `hello`; gw→Mac `open`; both ways `msg` / `close`;
 * Mac→gw `ping` every 20 s, answered `pong`. Unknown frame types are ignored.
 * Screenshots stay inside MCP results; the bridge writes no files but its
 * state file (on/off, the account, the private daemon's socket path).
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const MAC_BRIDGE_PATH = '/api/plugins/computer-use/bridge'
export const CUA_INSTALL_SCRIPT = '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"'
const TEAM_ID = 'YCK386LBJ7'
const BUNDLE_ID = 'com.trycua.driver'
const READY_TIMEOUT_MS = 15_000
const RETARGET_MS = 30_000
const PROTOCOL_VERSION = '2025-06-18'
const REAP_MIN_MS = 3000
const PING_MS = 20_000
/** With no inbound frame this long (once the gateway has answered a ping), the link is dead: redial. */
export const SILENCE_MS = 45_000
/** Open this long, or any frame received, before the reconnect backoff starts over. */
const STABLE_MS = 60_000
/**
 * Dials whose handshake never opened, in a row and spanning at least NEVER_OPENED_SPAN_MS, before a link
 * that never opened waits LONG_BACKOFF_MS. The span keeps a short outage (Wi-Fi not up yet at login, a
 * gateway restart) out of it: the Mac cannot tell a relay 502 from a 403.
 */
const NEVER_OPENED_LIMIT = 3
const NEVER_OPENED_SPAN_MS = 2 * 60_000
export const LONG_BACKOFF_MS = 10 * 60_000
/** Retries of a failed start while Enable stays on: 30 s, 60 s, then every 5 min. */
const START_RETRY_MS = [30_000, 60_000, 5 * 60_000]
/** Largest JSON-RPC message carried either way (CUA results carry MB-sized base64 screenshots). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
export const REPLACED_CODE = 4000
export const REPLACED_TEXT = 'Taken over by another Mac — turn Enable off and on to take it back.'
export const notSetUpText = (agent: string) => `Computer Use isn't set up for ${agent} yet`

// Same discovery as the Settings panel's spike (CuaDriver.app first, then PATH).
const APP_BINARIES = [
  '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
  path.join(os.homedir(), 'Applications/CuaDriver.app/Contents/MacOS/cua-driver')
]

export const DAEMON_ENV = {
  CUA_DRIVER_PERMISSION_MODE: 'unrestricted',
  CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1',
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0'
}

export type Frame =
  | { t: 'hello'; v: 1; cua_version: null | string; permission_mode: 'unrestricted'; tools: unknown[] }
  | { t: 'open'; c: string }
  | { t: 'msg'; c: string; m: Record<string, unknown> }
  | { t: 'close'; c: string }
  | { t: 'ping' }
  | { t: 'pong' }

/** The account Enable belongs to. */
export interface MacBridgeAccount {
  customerId: string
  agentId: string
}

export interface MacBridgeTarget {
  profile: string
  /** A fresh WebSocket URL (tickets are single-use), already bound to the profile. */
  url: () => Promise<string>
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface MacBridgeDeps {
  spawn: (command: string, args: string[], options: any) => any
  run: (command: string, args: string[], options?: any) => Promise<RunResult>
  /** Synchronous run; true when the command exited 0. */
  runSync: (command: string, args: string[], options?: any) => boolean
  WebSocket: any
  statePath: string
  resolveTargets: () => Promise<MacBridgeTarget[]>
  /** The signed-in account, or null (signed out, delegated support). */
  account: () => MacBridgeAccount | null
  log: (line: string) => void
  env?: NodeJS.ProcessEnv
  candidates?: string[]
  tmpdir?: string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (timer: any) => void
  maxMessageBytes?: number
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

export function decodeFrame(text: string): Frame | null {
  let frame: any

  try {
    frame = JSON.parse(text)
  } catch {
    return null
  }

  const conn = typeof frame?.c === 'string' && frame.c.length > 0

  if ((frame?.t === 'open' || frame?.t === 'close') && conn) {
    return { t: frame.t, c: frame.c }
  }

  if (frame?.t === 'msg' && conn && frame.m && typeof frame.m === 'object' && !Array.isArray(frame.m)) {
    return { t: 'msg', c: frame.c, m: frame.m }
  }

  if (frame?.t === 'pong') {
    return { t: 'pong' }
  }

  return null
}

/** Reconnect delay: 1 s, 2 s, 4 s … capped at 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))
}

/** Run by the page's "Install CUA": CUA's own installer in a visible Terminal window. */
export function installCommand(): [string, string[]] {
  return [
    '/usr/bin/osascript',
    [
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(CUA_INSTALL_SCRIPT)}`,
      '-e',
      'tell application "Terminal" to activate'
    ]
  ]
}

/** Run by "Grant permissions": macOS asks the user, attributed to CuaDriver. */
export function grantCommand(binary: string): [string, string[]] {
  return [binary, ['permissions', 'grant']]
}

const UNRESTRICTED = ['--no-permissions-gate', '--permission-mode', 'unrestricted', '--dangerously-bypass-approvals']

export function serveArgs(socket: string): string[] {
  return ['serve', '--embedded', '--socket', socket, ...UNRESTRICTED]
}

/**
 * Detached reaper for the daemon launched on `socket` (`open` gives no pid): until `untilMs` it looks for a
 * process running `serve` on exactly that path (a whole argv token, never a shorter or longer path),
 * SIGTERMs it, SIGKILLs it 2 s later if still there, removes the socket and exits. Detached so it outlives
 * quit; the random per-launch path is ours alone.
 */
const REAPER_SCRIPT = `S=$1; END=$2
ours() {
  for p in $(/usr/bin/pgrep -f -- "$S"); do
    [ "$p" = "$$" ] && continue
    case " $(/bin/ps -ww -o command= -p "$p") " in *" serve "*" --socket $S "*) echo "$p" ;; esac
  done
}
while :; do
  hit=$(ours)
  if [ -n "$hit" ]; then
    kill -TERM $hit 2>/dev/null; sleep 2
    left=$(ours); [ -n "$left" ] && kill -KILL $left 2>/dev/null
    rm -f "$S"; exit 0
  fi
  [ "$(/bin/date +%s)" -ge "$END" ] && exit 0
  sleep 0.5
done`

export function reaperArgs(socket: string, untilMs: number): [string, string[]] {
  return ['/bin/sh', ['-c', REAPER_SCRIPT, 'evaos-cua-reaper', socket, String(Math.ceil(untilMs / 1000))]]
}

interface EvaFacade {
  status: () => {
    desktopSessionActive?: boolean
    delegatedSupportActive?: boolean
    customerId?: null | string
    agentId?: null | string
  }
  delegatedProfiles: () => Promise<null | string[]>
  /** The enrollment's own agent (`runtime.agentId` outside delegated support). */
  assignedProfileId: () => Promise<null | string>
  /** Mints only for the user's own agent, checked and bound to the session in the same step. */
  ownProfileWsUrl: (request: { path: string; profile: string }) => Promise<string>
}

/** A remote (dev) connection has no account: one fixed identity, so Enable works there as before. */
const REMOTE_ACCOUNT: MacBridgeAccount = { customerId: 'remote', agentId: 'remote' }

export function sameAccount(a: MacBridgeAccount | null, b: MacBridgeAccount | null): boolean {
  return Boolean(a && b && a.customerId === b.customerId && a.agentId === b.agentId)
}

/** The signed-in account Enable is checked against; null when signed out or during delegated support. */
export function currentMacBridgeAccount(input: { managed: boolean; eva?: EvaFacade }): MacBridgeAccount | null {
  if (!input.managed) {
    return REMOTE_ACCOUNT
  }

  const status = input.eva?.status()

  if (!status?.desktopSessionActive || status.delegatedSupportActive || !status.customerId || !status.agentId) {
    return null
  }

  return { customerId: status.customerId, agentId: status.agentId }
}

/** Where the bridge dials: the signed-in user's own agent (managed) or the one remote connection. */
export async function resolveMacBridgeTargets(input: {
  managed: boolean
  eva?: EvaFacade
  remoteWsUrl?: () => Promise<null | string>
}): Promise<MacBridgeTarget[]> {
  const { eva } = input

  if (input.managed && eva) {
    const status = eva.status()

    // Delegated support: an admin acting for a customer never exposes this Mac.
    if (!status.desktopSessionActive || status.delegatedSupportActive || (await eva.delegatedProfiles()) !== null) {
      return []
    }

    // Only the enrollment's own agent, never every profile the account administers.
    const profile = await eva.assignedProfileId()

    if (!profile) {
      return []
    }

    // Each dial re-checks inside the mint itself: support can start between two reconnects.
    return [{ profile, url: () => eva.ownProfileWsUrl({ path: MAC_BRIDGE_PATH, profile }) }]
  }

  const base = input.remoteWsUrl ? await input.remoteWsUrl() : null

  if (!base) {
    return []
  }

  return [
    {
      profile: 'remote',
      url: async () => {
        const url = new URL((await input.remoteWsUrl?.()) || base)
        url.pathname = url.pathname.replace(/\/api\/ws$/, MAC_BRIDGE_PATH)

        return url.toString()
      }
    }
  ]
}

interface Child {
  proc: any
  profile: string
  conn: string
  lastActivity: number
}

interface Link {
  target: MacBridgeTarget
  ws: any
  state: 'connecting' | 'connected' | 'retrying' | 'replaced' | 'closed'
  gen: number
  error: null | string
  attempts: number
  timer: any
  children: Map<string, Child>
  /** This attempt created a WebSocket / saw it open; the link has opened at least once. */
  dialed: boolean
  opened: boolean
  everOpened: boolean
  /** Consecutive dials whose handshake never opened, and when the first of them ended. */
  neverOpened: number
  firstNeverOpenedAt: number
  lastInbound: number
  pongSeen: boolean
  /** Liveness timers of the current socket: ping, silence watchdog, stable-open reset. */
  pinger: any
  watchdog: any
  stable: any
}

interface SavedState {
  enabled: boolean
  account: MacBridgeAccount | null
  daemonSocket: null | string
}

const OWN_SOCKET_RE = /^evaos-cua-[0-9a-f]{12}\.sock$/

function validAccount(value: any): MacBridgeAccount | null {
  return typeof value?.customerId === 'string' &&
    value.customerId &&
    typeof value?.agentId === 'string' &&
    value.agentId
    ? { customerId: value.customerId, agentId: value.agentId }
    : null
}

export function createMacBridge(deps: MacBridgeDeps) {
  const env = deps.env || process.env
  const now = deps.now || Date.now

  const setTimer =
    deps.setTimer ||
    ((fn: () => void, ms: number) => {
      const timer: any = setTimeout(fn, ms)
      timer.unref?.() // never what keeps a process alive

      return timer
    })

  const clearTimer = deps.clearTimer || ((timer: any) => clearTimeout(timer))
  const log = (line: string) => deps.log(`[mac-bridge] ${line}`)
  const links = new Map<string, Link>()
  const saved = readState()
  let enabled = saved.enabled
  let account = saved.account
  let daemonSocket = saved.daemonSocket
  let running = false
  // Bumped by every start and stop: work that resumes under an older generation is abandoned.
  let gen = 0
  let socket: null | string = null
  let starting: null | { binary: string; sock: string; until: number } = null
  let hello: Frame | null = null
  let retargetTimer: any = null
  let lastError: null | string = null
  let cachedVersion: { binary: string; version: null | string } | null = null
  let startTimer: any = null
  let startFailures = 0

  /** A legacy file (no account) reads as off. */
  function readState(): SavedState {
    try {
      const state = JSON.parse(fs.readFileSync(deps.statePath, 'utf8'))
      const owner = validAccount(state.account)
      const sock = typeof state.daemonSocket === 'string' ? state.daemonSocket : ''

      return {
        enabled: state.enabled === true && owner !== null,
        account: owner,
        daemonSocket: path.isAbsolute(sock) && OWN_SOCKET_RE.test(path.basename(sock)) ? sock : null
      }
    } catch {
      return { enabled: false, account: null, daemonSocket: null }
    }
  }

  function saveState() {
    fs.mkdirSync(path.dirname(deps.statePath), { recursive: true })
    fs.writeFileSync(deps.statePath, JSON.stringify({ enabled, account, ...(daemonSocket ? { daemonSocket } : {}) }))
  }

  /** The private daemon's socket, on disk before it is launched: a crash leaves the path for the next start to reap. */
  function recordSocket(sock: null | string) {
    daemonSocket = sock

    try {
      saveState()
    } catch (error: any) {
      log(`could not save state: ${error?.message || error}`)
    }
  }

  const accountMatches = () => sameAccount(account, deps.account())

  function locate(): { binary: null | string; app: null | string; source: null | string } {
    const onPath = String(env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map(dir => path.join(dir, 'cua-driver'))

    const found = (
      deps.candidates || [...APP_BINARIES, ...onPath, path.join(os.homedir(), '.local/bin/cua-driver')]
    ).find(candidate => fs.existsSync(candidate))

    if (!found) {
      return { binary: null, app: null, source: null }
    }

    const real = fs.realpathSync(found)
    const app = /^(.*\/CuaDriver\.app)\//.exec(real)?.[1] ?? null

    return { binary: found, app, source: app ? 'app' : 'path' }
  }

  const daemonEnv = () => ({ ...env, ...DAEMON_ENV })

  async function version(binary: string): Promise<null | string> {
    if (cachedVersion?.binary !== binary) {
      const out = await deps.run(binary, ['--version']).catch(() => null)
      cachedVersion = { binary, version: /(\d+\.\d+\.\d+\S*)/.exec(out?.stdout || '')?.[1] ?? null }
    }

    return cachedVersion.version
  }

  const cancelled = () => new Error('Computer Use was turned off while CUA was starting.')

  async function startDaemon(my: number): Promise<void> {
    const { binary, app } = locate()

    if (!binary || !app) {
      throw new Error('CUA is not installed on this Mac (CuaDriver.app not found).')
    }

    const sign = await deps.run('/usr/bin/codesign', ['-dv', '--verbose=2', app])
    const fields = `${sign.stdout}\n${sign.stderr}`

    if (!fields.includes(`Identifier=${BUNDLE_ID}\n`) || !fields.includes(`TeamIdentifier=${TEAM_ID}`)) {
      throw new Error(`${app} is not CUA's signed CuaDriver.app (expected ${BUNDLE_ID}, team ${TEAM_ID}).`)
    }

    if (gen !== my) {
      throw cancelled()
    }

    // Recorded before launch, so a stop that lands mid-startup still finds (and stops) this daemon.
    const sock = path.join(deps.tmpdir || os.tmpdir(), `evaos-cua-${randomBytes(6).toString('hex')}.sock`)
    starting = { binary, sock, until: now() + READY_TIMEOUT_MS + 1000 }
    recordSocket(sock)
    await deps.run('/usr/bin/open', ['-n', '-g', '-a', app, '--args', ...serveArgs(sock)], { env: daemonEnv() })
    const deadline = now() + READY_TIMEOUT_MS

    while (now() < deadline) {
      const ready = (await deps.run(binary, ['status', '--socket', sock], { env: daemonEnv() })).code === 0

      if (gen !== my) {
        throw cancelled() // stopSync owned `starting` and stopped it
      }

      if (ready) {
        starting = null
        socket = sock
        log(`private daemon ready (unrestricted) on ${sock}`)

        return
      }

      await new Promise(resolve => setTimer(() => resolve(null), 100))

      if (gen !== my) {
        throw cancelled()
      }
    }

    starting = null
    stopDaemonAt(binary, sock, now())
    throw new Error('The private CUA daemon did not become ready within 15 s.')
  }

  /**
   * `cua-driver stop` for a daemon that is up, plus the reaper, which owns `sock` until `until`: it kills a
   * daemon that only becomes ready after Disable or quit (inside the startup window) or that `stop` missed.
   */
  function stopDaemonAt(binary: string, sock: string, until: number) {
    deps.runSync(binary, ['stop', '--socket', sock], { env: daemonEnv(), timeout: 3000 })
    fs.rmSync(sock, { force: true })
    const [command, args] = reaperArgs(sock, Date.now() + Math.max(REAP_MIN_MS, until - now()))
    deps.spawn(command, args, { detached: true, stdio: 'ignore' }).unref?.()
    log('private daemon stopped')
  }

  function stopDaemon() {
    const { binary } = locate()

    if (socket && binary) {
      stopDaemonAt(binary, socket, now())
    }

    if (starting) {
      stopDaemonAt(starting.binary, starting.sock, starting.until)
    }

    socket = null
    starting = null

    if (daemonSocket) {
      recordSocket(null)
    }
  }

  function spawnChild(): any {
    return deps.spawn(locate().binary!, ['mcp', '--embedded', '--socket', socket!], {
      env: daemonEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }

  function onLines(stream: any, handle: (message: any, bytes: number) => void) {
    // One decoder per stream: a multibyte character split across two chunks stays intact.
    const decoder = new StringDecoder('utf8')
    let buffered = ''

    stream.on('data', (chunk: Buffer | string) => {
      buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      const lines = buffered.split('\n')
      buffered = lines.pop() || ''

      for (const line of lines) {
        try {
          handle(JSON.parse(line), Buffer.byteLength(line))
        } catch {
          // not JSON-RPC (stray output): dropped
        }
      }
    })
  }

  /** The daemon's own tools/list, sent in `hello` so the gateway lists exactly these tools. */
  async function readHello(): Promise<Frame> {
    const child = spawnChild()
    const waiting = new Map<number, (result: any) => void>()
    onLines(child.stdout, message => waiting.get(message.id)?.(message.result))

    const ask = (id: number, method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimer(() => reject(new Error(`cua-driver did not answer ${method}`)), READY_TIMEOUT_MS)
        waiting.set(id, result => {
          clearTimer(timer)
          resolve(result)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })

    try {
      const clientInfo = { name: 'evaos-mac-bridge', version: '1' }
      const init = await ask(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const { tools } = await ask(2, 'tools/list', {})

      return {
        t: 'hello',
        v: 1,
        cua_version: init?.serverInfo?.version ?? null,
        permission_mode: 'unrestricted',
        tools
      }
    } finally {
      child.kill()
    }
  }

  function send(link: Link, frame: Frame) {
    if (link.ws?.readyState === 1) {
      link.ws.send(encodeFrame(frame))
    }
  }

  function openChild(link: Link, conn: string) {
    if (!socket) {
      // The private daemon is restarting: the gateway retries this conn, and reopens all of them on hello.
      const old = link.children.get(conn)
      link.children.delete(conn)
      old?.proc.kill()
      send(link, { t: 'close', c: conn })

      return
    }

    link.children.get(conn)?.proc.kill()
    const proc = spawnChild()
    const child: Child = { proc, profile: link.target.profile, conn, lastActivity: now() }
    link.children.set(conn, child)
    onLines(proc.stdout, (message, bytes) => {
      child.lastActivity = now()

      if (bytes > (deps.maxMessageBytes ?? MAX_MESSAGE_BYTES) && message.id !== undefined) {
        const error = { code: -32000, message: `The result (${bytes} bytes) is larger than the bridge carries.` }
        message = { jsonrpc: '2.0', id: message.id, error }
      }

      send(link, { t: 'msg', c: conn, m: message })
    })
    proc.stderr?.on('data', () => undefined)
    proc.once('exit', () => {
      if (link.children.get(conn) === child) {
        link.children.delete(conn)
        send(link, { t: 'close', c: conn })
      }
    })
  }

  function killChildren(link: Link) {
    for (const child of link.children.values()) {
      child.proc.kill()
    }

    link.children.clear()
  }

  function onFrame(link: Link, frame: Frame | null) {
    if (frame?.t === 'pong') {
      link.pongSeen = true
    } else if (frame?.t === 'open') {
      openChild(link, frame.c)
    } else if (frame?.t === 'msg') {
      const child = link.children.get(frame.c)

      if (child) {
        child.lastActivity = now()
        child.proc.stdin.write(`${JSON.stringify(frame.m)}\n`)
      }
    } else if (frame?.t === 'close') {
      const child = link.children.get(frame.c)
      link.children.delete(frame.c)
      child?.proc.kill()
    }
  }

  /** Still the link this run wants: not stopped, not restarted, not dropped by retarget. */
  const tracked = (link: Link) => running && link.gen === gen && links.get(link.target.profile) === link

  function clearLiveness(link: Link) {
    clearTimer(link.pinger)
    clearTimer(link.watchdog)
    clearTimer(link.stable)
    link.pinger = link.watchdog = link.stable = null
  }

  /** Ping every 20 s; once the gateway has answered one, 45 s without any inbound frame drops the link. */
  function startLiveness(link: Link, ws: any) {
    const ping = () => {
      if (link.ws === ws) {
        send(link, { t: 'ping' })
        link.pinger = setTimer(ping, PING_MS)
      }
    }

    link.pinger = setTimer(ping, PING_MS)
    link.stable = setTimer(() => {
      if (link.ws === ws) {
        link.attempts = 0
      }
    }, STABLE_MS)
  }

  function armWatchdog(link: Link, ws: any) {
    const check = () => {
      if (link.ws !== ws) {
        return
      }

      const silent = now() - link.lastInbound

      if (silent >= SILENCE_MS) {
        drop(link, ws, `no answer from ${link.target.profile} for ${Math.round(silent / 1000)} s`)
      } else {
        link.watchdog = setTimer(check, SILENCE_MS - silent)
      }
    }

    link.watchdog = setTimer(check, SILENCE_MS)
  }

  /** A dead socket (no close will come): forget it now and take the normal reconnect path. */
  function drop(link: Link, ws: any, why: string) {
    log(`${why}; reconnecting`)
    link.ws = null
    clearLiveness(link)
    killChildren(link)

    try {
      ws.close()
    } catch {
      // already closed
    }

    retry(link)
  }

  /** An attempt ended: count a dial whose handshake never opened. */
  function settle(link: Link) {
    if (link.opened) {
      link.neverOpened = 0
    } else if (link.dialed && link.neverOpened++ === 0) {
      link.firstNeverOpenedAt = now()
    }

    link.dialed = link.opened = false
  }

  async function connect(link: Link) {
    link.timer = null
    link.state = 'connecting'

    try {
      const url = await link.target.url()

      if (!tracked(link)) {
        return
      }

      const ws = new deps.WebSocket(url)
      link.ws = ws
      link.dialed = true
      const live = () => tracked(link) && link.ws === ws

      ws.onopen = () => {
        if (!live()) {
          return ws.close()
        }

        link.opened = link.everOpened = true
        link.neverOpened = 0
        link.state = 'connected'
        link.error = null
        link.lastInbound = now()
        link.pongSeen = false
        send(link, hello!)
        startLiveness(link, ws)
        log(`connected to ${link.target.profile}`)
      }

      ws.onmessage = (event: any) => {
        if (!live()) {
          return ws.close()
        }

        link.lastInbound = now()
        link.attempts = 0
        const frame = decodeFrame(String(event.data))

        if (frame?.t === 'pong' && !link.pongSeen) {
          armWatchdog(link, ws) // an old hub never pongs: then only a failed write ends the link
        }

        onFrame(link, frame)
      }

      ws.onerror = (event: any) => {
        link.error = String(event?.message || event?.error?.message || 'connection error')
      }

      ws.onclose = (event: any) => {
        if (link.ws !== ws) {
          return
        }

        clearLiveness(link)
        killChildren(link)

        if (event?.code === REPLACED_CODE) {
          // Another Mac of this user took over: terminal until the user toggles Enable.
          settle(link)
          link.ws = null
          link.state = 'replaced'
          link.error = REPLACED_TEXT
        } else {
          retry(link)
        }
      }
    } catch (error: any) {
      link.error = error?.message || String(error)

      if (tracked(link)) {
        retry(link)
      }
    }
  }

  function retry(link: Link) {
    link.ws = null
    settle(link)

    if (!running || links.get(link.target.profile) !== link) {
      link.state = 'closed'

      return
    }

    link.state = 'retrying'

    // A link that never opened (the gateway plugin is not installed for this agent): stop knocking every 30 s.
    if (
      !link.everOpened &&
      link.neverOpened >= NEVER_OPENED_LIMIT &&
      now() - link.firstNeverOpenedAt >= NEVER_OPENED_SPAN_MS
    ) {
      link.error = notSetUpText(link.target.profile)
      link.timer = setTimer(() => void connect(link), LONG_BACKOFF_MS)
    } else {
      link.timer = setTimer(() => void connect(link), backoffMs(link.attempts++))
    }
  }

  function closeLink(link: Link) {
    links.delete(link.target.profile)
    clearTimer(link.timer)
    clearLiveness(link)
    link.state = 'closed'
    const ws = link.ws
    link.ws = null
    killChildren(link)
    ws?.close()
  }

  /** After sleep or a screen lock: every socket may be dead without a close, so redial them all now. */
  function redial() {
    for (const link of links.values()) {
      if (link.state === 'replaced' || link.state === 'closed' || (link.state === 'connecting' && !link.ws)) {
        continue // terminal, or still minting its URL
      }

      const ws = link.ws
      link.ws = null
      clearTimer(link.timer)
      clearLiveness(link)
      killChildren(link)
      ws?.close()
      settle(link)
      link.attempts = 0
      void connect(link)
    }
  }

  /** A sign-in starts the backoff over, including the long one. */
  async function signedIn() {
    for (const link of links.values()) {
      if (link.state === 'retrying') {
        clearTimer(link.timer)
        link.attempts = link.neverOpened = 0
        void connect(link)
      }
    }

    await retarget()
  }

  /** The 30 s tick: the private daemon must still answer on our socket (never the user's own daemon). */
  async function checkDaemon(my: number) {
    const { binary } = locate()
    const sock = socket

    if (!sock || !binary) {
      return
    }

    const up = (await deps.run(binary, ['status', '--socket', sock], { env: daemonEnv() })).code === 0

    if (up || gen !== my || socket !== sock) {
      return
    }

    log('private daemon stopped answering; restarting it')
    socket = null

    for (const link of links.values()) {
      killChildren(link) // their daemon is gone
    }

    stopDaemonAt(binary, sock, now())

    try {
      await startDaemon(my)
      const next = await readHello()

      if (gen !== my) {
        return
      }

      hello = next

      for (const link of links.values()) {
        if (link.state === 'connected') {
          send(link, hello) // the gateway opens a fresh child for every conn
        }
      }
    } catch (error: any) {
      if (gen === my) {
        fail(error)
      }
    }
  }

  async function tick() {
    const my = gen

    try {
      await checkDaemon(my)
    } catch (error: any) {
      log(`daemon check failed: ${error?.message || error}`)
    }

    if (gen === my) {
      await retarget()
    }
  }

  /** Open links for new profiles, drop links for profiles no longer offered. */
  async function retarget() {
    if (!running || !hello) {
      return // start() retargets once the daemon is up
    }

    const my = gen
    const before = deps.account()
    let targets: MacBridgeTarget[] | null = null

    if (before && !sameAccount(account, before)) {
      targets = [] // another account: this Mac is not theirs to offer
    } else {
      // Also with no account: signed out resolves to none, and a lapsed runtime (sleep, a missed refresh)
      // is re-enrolled by the lookup itself.
      try {
        targets = await deps.resolveTargets()
        lastError = null
      } catch (error: any) {
        // Transient (e.g. a refresh that failed): keep the links we have.
        lastError = error?.message || String(error)
      }
    }

    if (!running || gen !== my) {
      return
    }

    // Checked again after the lookup: the account can change while it runs, and nothing is dialed for another.
    const current = deps.account()

    if (current ? !sameAccount(account, current) : targets !== null) {
      targets = [] // a failed lookup with no account (a lapsed runtime) keeps the links, as above
    }

    if (targets) {
      const wanted = new Map(targets.map(target => [target.profile, target]))

      for (const link of [...links.values()]) {
        if (!wanted.has(link.target.profile)) {
          closeLink(link)
        }
      }

      for (const target of wanted.values()) {
        if (running && !links.has(target.profile)) {
          const link: Link = {
            target,
            ws: null,
            state: 'connecting',
            error: null,
            attempts: 0,
            timer: null,
            children: new Map(),
            gen,
            dialed: false,
            opened: false,
            everOpened: false,
            neverOpened: 0,
            firstNeverOpenedAt: 0,
            lastInbound: 0,
            pongSeen: false,
            pinger: null,
            watchdog: null,
            stable: null
          }

          links.set(target.profile, link)
          void connect(link)
        }
      }
    }

    clearTimer(retargetTimer)
    retargetTimer = running ? setTimer(() => void tick(), RETARGET_MS) : null
  }

  async function start() {
    if (running) {
      return
    }

    clearTimer(startTimer)
    startTimer = null
    running = true
    const my = ++gen
    lastError = null

    try {
      await startDaemon(my)
      const next = await readHello()

      if (gen !== my) {
        return
      }

      hello = next
      startFailures = 0
      await retarget()
    } catch (error: any) {
      if (gen === my) {
        fail(error)
      }
    }
  }

  /** Start failed (or the daemon could not be restarted): stop, and try again later while Enable stays on. */
  function fail(error: any) {
    lastError = error?.message || String(error)
    log(`start failed: ${lastError}`)
    halt()

    if (enabled) {
      const delay = START_RETRY_MS[Math.min(startFailures, START_RETRY_MS.length - 1)]
      startFailures += 1
      startTimer = setTimer(() => {
        startTimer = null

        if (enabled) {
          void start()
        }
      }, delay)
    }
  }

  function halt() {
    gen += 1
    running = false
    clearTimer(retargetTimer)
    retargetTimer = null

    for (const link of [...links.values()]) {
      closeLink(link)
    }

    stopDaemon()
    hello = null
  }

  function stopSync() {
    clearTimer(startTimer)
    startTimer = null
    startFailures = 0
    halt()
  }

  async function setEnabled(value: boolean) {
    enabled = value
    // Turning it on (or off) makes it this account's switch.
    account = deps.account()
    saveState()

    if (!enabled) {
      stopSync()
    } else if (running) {
      await retarget() // the daemon already runs (for this or another account): dial for this one
    } else {
      startFailures = 0
      await start()
    }

    return status()
  }

  async function permissions(binary: string) {
    const args = ['permissions', 'status', '--json', ...(socket ? ['--socket', socket] : [])]
    const out = await deps.run(binary, args, { env: daemonEnv() }).catch(() => null)

    try {
      const parsed = JSON.parse(out?.stdout || '')

      return { accessibility: parsed.accessibility ?? null, screen_recording: parsed.screen_recording ?? null }
    } catch {
      return { accessibility: null, screen_recording: null }
    }
  }

  async function status() {
    const found = locate()

    return {
      // Shown off to any other account signed in on this Mac; on while a lapsed runtime keeps this one's links.
      enabled: enabled && (accountMatches() || (deps.account() === null && links.size > 0)),
      cua: {
        found: Boolean(found.binary),
        path: found.binary,
        source: found.source,
        version: found.binary ? await version(found.binary) : null
      },
      permissions: found.binary ? await permissions(found.binary) : null,
      daemon: { running: Boolean(socket), mode: socket ? 'unrestricted' : null },
      connections: [...links.values()].map(link => ({
        profile: link.target.profile,
        state: link.state,
        error: link.error
      })),
      inUse: [...links.values()].flatMap(link =>
        [...link.children.values()].map(child => ({
          profile: child.profile,
          conn: child.conn,
          lastActivity: child.lastActivity
        }))
      ),
      error: lastError
    }
  }

  async function launch([command, args]: [string, string[]]) {
    const proc = deps.spawn(command, args, { detached: true, stdio: 'ignore', env })
    proc.unref?.()
  }

  /** App start: reap a daemon a crash left behind (its path was recorded before launch), then start if on. */
  function init() {
    if (daemonSocket) {
      const [command, args] = reaperArgs(daemonSocket, Date.now() + REAP_MIN_MS)
      deps.spawn(command, args, { detached: true, stdio: 'ignore' }).unref?.()
      log('reaping a private daemon left by an earlier run')
      recordSocket(null)
    }

    return enabled ? start() : Promise.resolve()
  }

  return {
    init,
    setEnabled,
    status,
    retarget,
    redial,
    signedIn,
    installCua: () => launch(installCommand()),
    grantPermissions: async () => {
      const { binary } = locate()

      if (binary) {
        await launch(grantCommand(binary))
      }
    },
    stopSync
  }
}

export type MacBridge = ReturnType<typeof createMacBridge>
export type MacBridgeStatus = Awaited<ReturnType<MacBridge['status']>>

export function registerMacBridgeIpc(
  ipcMain: { handle: (channel: string, listener: (...args: any[]) => any) => void },
  bridge: MacBridge
): void {
  ipcMain.handle('hermes:macBridge:status', () => bridge.status())
  ipcMain.handle('hermes:macBridge:setEnabled', (_event, value: boolean) => bridge.setEnabled(value === true))
  ipcMain.handle('hermes:macBridge:installCua', () => bridge.installCua())
  ipcMain.handle('hermes:macBridge:grantPermissions', () => bridge.grantPermissions())
}
