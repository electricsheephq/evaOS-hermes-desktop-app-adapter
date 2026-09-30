/**
 * Mac bridge: this Mac's CUA, served to the user's own agents.
 *
 * When the user turns Computer Use on, main starts a PRIVATE cua-driver daemon
 * (its own socket, launched through CuaDriver.app so macOS permissions stay with
 * `com.trycua.driver`) and opens one outbound WebSocket per profile the user
 * owns, to that profile's `computer-use` gateway plugin. The gateway asks for a
 * connection (`open`), and each one gets its own `cua-driver mcp` child, so every
 * agent (Desktop chat, Telegram, cron) has its own CUA session and they run in
 * parallel. JSON-RPC passes through untouched: the switch is the user's on/off,
 * not a gate, and nothing here narrows what CUA can do. Never during delegated
 * support: an admin's Mac is never offered to a customer's agents.
 *
 * Frames (JSON text): Mac→gw `hello`; gw→Mac `open`; both ways `msg` / `close`.
 * Screenshots stay inside MCP results; the bridge writes no files but its
 * on/off state.
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MAC_BRIDGE_PATH = '/api/plugins/computer-use/bridge'
export const CUA_INSTALL_SCRIPT = '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"'
const TEAM_ID = 'YCK386LBJ7'
const BUNDLE_ID = 'com.trycua.driver'
const READY_TIMEOUT_MS = 15_000
const RETARGET_MS = 30_000
const PROTOCOL_VERSION = '2025-06-18'

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
  runSync: (command: string, args: string[], options?: any) => void
  WebSocket: any
  statePath: string
  resolveTargets: () => Promise<MacBridgeTarget[]>
  log: (line: string) => void
  env?: NodeJS.ProcessEnv
  candidates?: string[]
  tmpdir?: string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (timer: any) => void
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

/** Where the bridge dials: every profile the user owns (managed) or the one remote connection. */
export async function resolveMacBridgeTargets(input: {
  managed: boolean
  eva?: {
    status: () => { desktopSessionActive?: boolean; delegatedSupportActive?: boolean }
    delegatedProfiles: () => Promise<null | string[]>
    authorizedProfiles: () => Promise<string[]>
    freshWsUrl: (request: { path: string; profile: string }) => Promise<string>
  }
  remoteWsUrl?: () => Promise<null | string>
}): Promise<MacBridgeTarget[]> {
  const { eva } = input

  if (input.managed && eva) {
    const status = eva.status()

    // Delegated support: an admin acting for a customer never exposes this Mac.
    if (!status.desktopSessionActive || status.delegatedSupportActive || (await eva.delegatedProfiles()) !== null) {
      return []
    }

    return (await eva.authorizedProfiles()).map(profile => ({
      profile,
      url: async () => {
        // Checked again per dial: support can start between two reconnects.
        if (eva.status().delegatedSupportActive || (await eva.delegatedProfiles()) !== null) {
          throw new Error('delegated support is active')
        }

        return eva.freshWsUrl({ path: MAC_BRIDGE_PATH, profile })
      }
    }))
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
  state: 'connecting' | 'connected' | 'retrying' | 'closed'
  error: null | string
  attempts: number
  timer: any
  children: Map<string, Child>
}

export function createMacBridge(deps: MacBridgeDeps) {
  const env = deps.env || process.env
  const now = deps.now || Date.now
  const setTimer = deps.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer || ((timer: any) => clearTimeout(timer))
  const log = (line: string) => deps.log(`[mac-bridge] ${line}`)
  const links = new Map<string, Link>()
  let enabled = readEnabled()
  let running = false
  let socket: null | string = null
  let hello: Frame | null = null
  let retargetTimer: any = null
  let lastError: null | string = null
  let cachedVersion: { binary: string; version: null | string } | null = null

  function readEnabled(): boolean {
    try {
      return JSON.parse(fs.readFileSync(deps.statePath, 'utf8')).enabled === true
    } catch {
      return false
    }
  }

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

  async function startDaemon(): Promise<void> {
    const { binary, app } = locate()

    if (!binary || !app) {
      throw new Error('CUA is not installed on this Mac (CuaDriver.app not found).')
    }

    const sign = await deps.run('/usr/bin/codesign', ['-dv', '--verbose=2', app])
    const fields = `${sign.stdout}\n${sign.stderr}`

    if (!fields.includes(`Identifier=${BUNDLE_ID}\n`) || !fields.includes(`TeamIdentifier=${TEAM_ID}`)) {
      throw new Error(`${app} is not CUA's signed CuaDriver.app (expected ${BUNDLE_ID}, team ${TEAM_ID}).`)
    }

    const sock = path.join(deps.tmpdir || os.tmpdir(), `evaos-cua-${randomBytes(6).toString('hex')}.sock`)
    await deps.run('/usr/bin/open', ['-n', '-g', '-a', app, '--args', ...serveArgs(sock)], { env: daemonEnv() })
    const deadline = now() + READY_TIMEOUT_MS

    while (now() < deadline) {
      if ((await deps.run(binary, ['status', '--socket', sock], { env: daemonEnv() })).code === 0) {
        socket = sock
        log(`private daemon ready (unrestricted) on ${sock}`)

        return
      }

      await new Promise(resolve => setTimer(() => resolve(null), 100))
    }

    deps.runSync(binary, ['stop', '--socket', sock], { env: daemonEnv(), timeout: 3000 })
    throw new Error('The private CUA daemon did not become ready within 15 s.')
  }

  function stopDaemon() {
    const { binary } = locate()

    if (socket && binary) {
      deps.runSync(binary, ['stop', '--socket', socket], { env: daemonEnv(), timeout: 3000 })
      fs.rmSync(socket, { force: true })
      log('private daemon stopped')
    }

    socket = null
  }

  function spawnChild(): any {
    return deps.spawn(locate().binary!, ['mcp', '--embedded', '--socket', socket!], {
      env: daemonEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }

  function onLines(stream: any, handle: (message: any) => void) {
    let buffered = ''

    stream.on('data', (chunk: Buffer | string) => {
      buffered += String(chunk)
      const lines = buffered.split('\n')
      buffered = lines.pop() || ''

      for (const line of lines) {
        try {
          handle(JSON.parse(line))
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
    link.children.get(conn)?.proc.kill()
    const proc = spawnChild()
    const child: Child = { proc, profile: link.target.profile, conn, lastActivity: now() }
    link.children.set(conn, child)
    onLines(proc.stdout, message => {
      child.lastActivity = now()
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
    if (frame?.t === 'open') {
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

  async function connect(link: Link) {
    link.timer = null
    link.state = 'connecting'

    try {
      const ws = new deps.WebSocket(await link.target.url())
      link.ws = ws

      ws.onopen = () => {
        link.attempts = 0
        link.state = 'connected'
        link.error = null
        send(link, hello!)
        log(`connected to ${link.target.profile}`)
      }

      ws.onmessage = (event: any) => onFrame(link, decodeFrame(String(event.data)))

      ws.onerror = (event: any) => {
        link.error = String(event?.message || event?.error?.message || 'connection error')
      }

      ws.onclose = () => {
        if (link.ws === ws) {
          killChildren(link)
          retry(link)
        }
      }
    } catch (error: any) {
      link.error = error?.message || String(error)
      retry(link)
    }
  }

  function retry(link: Link) {
    link.ws = null

    if (!running || links.get(link.target.profile) !== link) {
      link.state = 'closed'

      return
    }

    link.state = 'retrying'
    link.timer = setTimer(() => void connect(link), backoffMs(link.attempts++))
  }

  function closeLink(link: Link) {
    links.delete(link.target.profile)
    clearTimer(link.timer)
    link.state = 'closed'
    const ws = link.ws
    link.ws = null
    killChildren(link)
    ws?.close()
  }

  /** Open links for new profiles, drop links for profiles no longer offered. */
  async function retarget() {
    if (!running) {
      return
    }

    let targets: MacBridgeTarget[] = []

    try {
      targets = await deps.resolveTargets()
      lastError = null
    } catch (error: any) {
      lastError = error?.message || String(error)
    }

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
          children: new Map()
        }

        links.set(target.profile, link)
        void connect(link)
      }
    }

    clearTimer(retargetTimer)
    retargetTimer = running ? setTimer(() => void retarget(), RETARGET_MS) : null
  }

  async function start() {
    if (running) {
      return
    }

    running = true

    try {
      await startDaemon()
      hello = await readHello()
      await retarget()
    } catch (error: any) {
      lastError = error?.message || String(error)
      log(`start failed: ${lastError}`)
      stopSync()
    }
  }

  function stopSync() {
    running = false
    clearTimer(retargetTimer)
    retargetTimer = null

    for (const link of [...links.values()]) {
      closeLink(link)
    }

    stopDaemon()
    hello = null
  }

  async function setEnabled(value: boolean) {
    enabled = value
    fs.mkdirSync(path.dirname(deps.statePath), { recursive: true })
    fs.writeFileSync(deps.statePath, JSON.stringify({ enabled }))

    if (enabled) {
      await start()
    } else {
      stopSync()
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
      enabled,
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

  return {
    init: () => (enabled ? start() : Promise.resolve()),
    setEnabled,
    status,
    retarget,
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
