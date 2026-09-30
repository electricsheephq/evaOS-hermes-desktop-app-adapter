import { spawn as spawnReal } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  backoffMs,
  createMacBridge,
  CUA_INSTALL_SCRIPT,
  DAEMON_ENV,
  decodeFrame,
  encodeFrame,
  grantCommand,
  installCommand,
  LONG_BACKOFF_MS,
  MAC_BRIDGE_PATH,
  type MacBridgeAccount,
  notSetUpText,
  reaperArgs,
  REPLACED_CODE,
  REPLACED_TEXT,
  resolveMacBridgeTargets,
  serveArgs,
  SILENCE_MS
} from './mac-bridge'

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written: any[] = []
  killed = false
  stdin = {
    write: (line: string) => {
      const message = JSON.parse(line)
      this.written.push(message)

      // The hello probe: answer initialize / tools/list like cua-driver does.
      if (message.method === 'initialize' && message.id === 1) {
        this.reply({ id: 1, result: { serverInfo: { name: 'cua-driver', version: '0.30.2' } } })
      } else if (message.method === 'tools/list' && message.id === 2) {
        this.reply({ id: 2, result: { tools: [{ name: 'click' }, { name: 'get_config' }] } })
      }
    }
  }

  reply(message: object) {
    this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  kill() {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
  }
}

class FakeWs {
  static all: FakeWs[] = []
  readyState = 0
  sent: any[] = []
  closed = false
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event?: { code: number }) => void
  onerror?: (event: any) => void

  constructor(readonly url: string) {
    FakeWs.all.push(this)
  }

  send(text: string) {
    this.sent.push(JSON.parse(text))
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  frame(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close(code = 1000) {
    this.closed = true
    this.readyState = 3
    this.onclose?.({ code })
  }
}

let dir: string
let procs: { command: string; args: string[]; options: any; proc: FakeProc }[]
let runs: { command: string; args: string[]; options: any }[]
let syncRuns: { command: string; args: string[] }[]
let timers: { fn: () => void; ms: number }[]
let binary: string
let clock: number
let signedInAs: MacBridgeAccount | null

const ACCOUNT_A = { customerId: 'jackie-david', agentId: 'alice' }
const ACCOUNT_B = { customerId: 'jackie-david', agentId: 'bob' }

function bridge(
  targets: { profile: string; url: () => Promise<string> }[] = [
    { profile: 'alice', url: async () => 'ws://gw/api/plugins/computer-use/bridge?token=t' }
  ],
  overrides: Partial<Parameters<typeof createMacBridge>[0]> = {}
) {
  return createMacBridge({
    spawn: (command, args, options) => {
      const proc = new FakeProc()
      procs.push({ command, args, options, proc })

      return proc
    },
    run: async (command, args, options) => {
      runs.push({ command, args, options })

      if (command === '/usr/bin/codesign') {
        return { code: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\n' }
      }

      if (args[0] === '--version') {
        return { code: 0, stdout: 'cua-driver 0.30.2\n', stderr: '' }
      }

      if (args[0] === 'permissions') {
        return { code: 0, stdout: '{"accessibility": true, "screen_recording": false}', stderr: '' }
      }

      return { code: 0, stdout: '', stderr: '' }
    },
    runSync: (command, args) => {
      syncRuns.push({ command, args })

      return true
    },
    WebSocket: FakeWs,
    statePath: path.join(dir, 'mac-bridge.json'),
    resolveTargets: async () => targets,
    account: () => signedInAs,
    log: () => undefined,
    candidates: [binary],
    tmpdir: dir,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms }
      timers.push(timer)

      return timer
    },
    clearTimer: timer => void (timers = timers.filter(entry => entry !== timer)),
    ...overrides
  })
}

const stops = () => syncRuns.filter(entry => entry.args[0] === 'stop')

const flush = () => new Promise(resolve => setImmediate(resolve))
const children = () => procs.filter(entry => entry.args[0] === 'mcp').slice(1) // [0] is the hello probe

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-')))
  binary = path.join(dir, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver')
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, '')
  procs = []
  runs = []
  syncRuns = []
  timers = []
  FakeWs.all = []
  clock = 1_000_000
  signedInAs = ACCOUNT_A
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('frames', () => {
  it('encodes and decodes the four frames and rejects anything else', () => {
    expect(decodeFrame(encodeFrame({ t: 'open', c: 'a1' }))).toEqual({ t: 'open', c: 'a1' })
    expect(decodeFrame(encodeFrame({ t: 'close', c: 'a1' }))).toEqual({ t: 'close', c: 'a1' })
    expect(decodeFrame('{"t":"msg","c":"a1","m":{"id":1,"method":"tools/list"}}')).toEqual({
      t: 'msg',
      c: 'a1',
      m: { id: 1, method: 'tools/list' }
    })
    expect(
      JSON.parse(encodeFrame({ t: 'hello', v: 1, cua_version: '0.30.2', permission_mode: 'unrestricted', tools: [] }))
    ).toEqual({ t: 'hello', v: 1, cua_version: '0.30.2', permission_mode: 'unrestricted', tools: [] })

    expect(decodeFrame('{"t":"pong"}')).toEqual({ t: 'pong' })
    expect(encodeFrame({ t: 'ping' })).toBe('{"t":"ping"}')

    for (const bad of ['nope', '{"t":"open"}', '{"t":"msg","c":"a","m":[1]}', '{"t":"exec","c":"a"}']) {
      expect(decodeFrame(bad)).toBeNull()
    }
  })

  it('backs off 1 s, 2 s, 4 s … up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe('page buttons', () => {
  it('Install CUA runs the official installer in a visible Terminal window', () => {
    const [command, args] = installCommand()
    expect(command).toBe('/usr/bin/osascript')
    expect(args[1]).toBe(
      'tell application "Terminal" to do script "/bin/bash -c \\"$(curl -fsSL https://cua.ai/driver/install.sh)\\""'
    )
    expect(CUA_INSTALL_SCRIPT).toBe('/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"')
  })

  it('Grant permissions runs `cua-driver permissions grant`', () => {
    expect(grantCommand('/x/cua-driver')).toEqual(['/x/cua-driver', ['permissions', 'grant']])
  })
})

describe('the bridge', () => {
  it('starts a private unrestricted daemon, says hello, and runs one CUA child per connection', async () => {
    const mb = bridge()
    await mb.setEnabled(true)

    const open = runs.find(entry => entry.command === '/usr/bin/open')!
    const sock = open.args[8]
    expect(open.args.slice(0, 5)).toEqual(['-n', '-g', '-a', path.join(dir, 'CuaDriver.app'), '--args'])
    expect(open.args.slice(5)).toEqual(serveArgs(sock))
    expect(open.options.env).toMatchObject(DAEMON_ENV)
    expect(sock.startsWith(dir)).toBe(true)

    const ws = FakeWs.all[0]
    expect(ws.url).toBe('ws://gw/api/plugins/computer-use/bridge?token=t')
    ws.open()
    expect(ws.sent[0]).toEqual({
      t: 'hello',
      v: 1,
      cua_version: '0.30.2',
      permission_mode: 'unrestricted',
      tools: [{ name: 'click' }, { name: 'get_config' }]
    })

    ws.frame({ t: 'open', c: 'c1' })
    ws.frame({ t: 'open', c: 'c2' })
    expect(children().map(entry => entry.args)).toEqual([
      ['mcp', '--embedded', '--socket', sock],
      ['mcp', '--embedded', '--socket', sock]
    ])
    const [one, two] = children().map(entry => entry.proc)

    ws.frame({ t: 'msg', c: 'c2', m: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'click' } } })
    expect(two.written).toEqual([{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'click' } }])
    expect(one.written).toEqual([])
    two.reply({ id: 4, result: { content: [] } })
    expect(ws.sent.at(-1)).toEqual({ t: 'msg', c: 'c2', m: { jsonrpc: '2.0', id: 4, result: { content: [] } } })

    const status = await mb.status()
    expect(status.daemon).toEqual({ running: true, mode: 'unrestricted' })
    expect(status.inUse.map(use => [use.profile, use.conn])).toEqual([
      ['alice', 'c1'],
      ['alice', 'c2']
    ])
    expect(status.connections).toEqual([{ profile: 'alice', state: 'connected', error: null }])
    expect(status.permissions).toEqual({ accessibility: true, screen_recording: false })

    ws.frame({ t: 'close', c: 'c1' })
    expect(one.killed).toBe(true)
    one.emit('exit') // a gateway-requested close is not echoed back
    two.kill() // a child that exits on its own is reported
    expect(ws.sent.filter(frame => frame.t === 'close')).toEqual([{ t: 'close', c: 'c2' }])
  })

  it('reconnects with backoff and kills the connection’s children when the socket drops', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()
    FakeWs.all[0].frame({ t: 'open', c: 'c1' })
    FakeWs.all[0].close()
    expect(children()[0].proc.killed).toBe(true)
    expect(timers.map(timer => timer.ms)).toContain(1000)

    timers.find(timer => timer.ms === 1000)!.fn()
    await flush()
    FakeWs.all[1].close() // failed again before opening
    expect(timers.map(timer => timer.ms)).toContain(2000)

    timers.find(timer => timer.ms === 2000)!.fn()
    await flush()
    FakeWs.all[2].open()
    expect((await mb.status()).connections[0].state).toBe('connected')
  })

  it('Enable off closes the socket, kills the children and stops the private daemon', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    const sock = runs.find(entry => entry.command === '/usr/bin/open')!.args[8]
    FakeWs.all[0].open()
    FakeWs.all[0].frame({ t: 'open', c: 'c1' })

    const status = await mb.setEnabled(false)
    expect(FakeWs.all[0].closed).toBe(true)
    expect(children()[0].proc.killed).toBe(true)
    expect(stops()).toEqual([{ command: binary, args: ['stop', '--socket', sock] }])
    expect(status.enabled).toBe(false)
    expect(status.daemon.running).toBe(false)
    expect(status.connections).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'mac-bridge.json'), 'utf8'))).toEqual({
      enabled: false,
      account: ACCOUNT_A
    })
    expect(timers).toEqual([]) // no reconnect, no retarget
  })

  it('stays off by default and refuses a driver that is not CUA’s signed app', async () => {
    const mb = bridge()
    await mb.init()
    expect(runs.filter(entry => entry.command === '/usr/bin/open')).toEqual([])

    const unsigned = createMacBridge({
      ...({} as any),
      spawn: () => new FakeProc(),
      run: async () => ({ code: 0, stdout: '', stderr: 'Identifier=com.example.fake\nTeamIdentifier=XXXX\n' }),
      runSync: () => undefined,
      WebSocket: FakeWs,
      statePath: path.join(dir, 'x.json'),
      resolveTargets: async () => [],
      account: () => ACCOUNT_A,
      log: () => undefined,
      candidates: [binary]
    })

    const status = await unsigned.setEnabled(true)
    expect(status.error).toMatch(/not CUA's signed CuaDriver\.app/)
    expect(status.daemon.running).toBe(false)
  })
})

describe('targets', () => {
  const eva = (overrides: any = {}) => ({
    status: () => ({ desktopSessionActive: true, delegatedSupportActive: false, ...overrides.status }),
    delegatedProfiles: async () => overrides.delegated ?? null,
    // A profile admin administers several profiles; the bridge must not dial them.
    authorizedProfiles: async () => ['jane', 'louis', 'regan'],
    assignedProfileId: async () => ('assigned' in overrides ? overrides.assigned : 'jane'),
    ownProfileWsUrl: async ({ path: p, profile }: { path: string; profile: string }) => {
      if (overrides.supportStarted?.()) {
        throw new Error('This profile is not one of your own agents.')
      }

      return `ws://127.0.0.1:9/${profile}${p}?ticket=x`
    }
  })

  it('opens one bridge, to the enrollment’s own agent only, through the relay', async () => {
    const targets = await resolveMacBridgeTargets({ managed: true, eva: eva() })
    expect(targets.map(target => target.profile)).toEqual(['jane'])
    expect(await targets[0].url()).toBe(`ws://127.0.0.1:9/jane${MAC_BRIDGE_PATH}?ticket=x`)
    expect(await resolveMacBridgeTargets({ managed: true, eva: eva({ assigned: null }) })).toEqual([])
    expect(await resolveMacBridgeTargets({ managed: true, eva: eva({ assigned: '' }) })).toEqual([])
  })

  it('opens NO bridge during delegated support or when signed out', async () => {
    expect(
      await resolveMacBridgeTargets({ managed: true, eva: eva({ status: { delegatedSupportActive: true } }) })
    ).toEqual([])
    expect(await resolveMacBridgeTargets({ managed: true, eva: eva({ delegated: ['customer'] }) })).toEqual([])
    expect(
      await resolveMacBridgeTargets({ managed: true, eva: eva({ status: { desktopSessionActive: false } }) })
    ).toEqual([])

    // Support starting between two dials is refused inside the mint itself (eva-runtime.test.cjs).
    let started = false
    const [target] = await resolveMacBridgeTargets({ managed: true, eva: eva({ supportStarted: () => started }) })
    started = true
    await expect(target.url()).rejects.toThrow(/not one of your own/)
  })

  it('uses the single remote connection in remote mode', async () => {
    const targets = await resolveMacBridgeTargets({
      managed: false,
      remoteWsUrl: async () => 'ws://127.0.0.1:19480/api/ws?token=abc'
    })

    expect(targets.map(target => target.profile)).toEqual(['remote'])
    expect(await targets[0].url()).toBe(`ws://127.0.0.1:19480${MAC_BRIDGE_PATH}?token=abc`)
    expect(await resolveMacBridgeTargets({ managed: false, remoteWsUrl: async () => null })).toEqual([])
  })
})

describe('review round 2', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => (resolve = done))

    return { promise, resolve }
  }

  it('a dial refused by the mint opens no WebSocket', async () => {
    const mb = bridge([{ profile: 'alice', url: async () => Promise.reject(new Error('not one of your own agents')) }])
    await mb.setEnabled(true)
    expect(FakeWs.all).toEqual([])
    expect((await mb.status()).connections[0]).toMatchObject({ state: 'retrying', error: 'not one of your own agents' })
  })

  it('Disable during daemon startup stops that daemon exactly once and leaves nothing running', async () => {
    const ready = deferred<{ code: number; stdout: string; stderr: string }>()

    const mb = bridge(undefined, {
      run: async (command, args, options) => {
        runs.push({ command, args, options })

        if (command === '/usr/bin/codesign') {
          return { code: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\n' }
        }

        return args[0] === 'status' ? ready.promise : { code: 0, stdout: '', stderr: '' }
      }
    })

    const enabling = mb.setEnabled(true)
    await flush()
    const sock = runs.find(entry => entry.command === '/usr/bin/open')!.args[8]

    const off = await mb.setEnabled(false)
    expect(stops()).toEqual([{ command: binary, args: ['stop', '--socket', sock] }])
    ready.resolve({ code: 0, stdout: '', stderr: '' }) // the daemon comes up after the stop was issued
    await enabling
    await flush()

    expect(stops()).toHaveLength(1)
    expect(off.daemon.running).toBe(false)
    expect((await mb.status()).daemon.running).toBe(false)
    expect(procs.filter(entry => entry.args[0] === 'mcp')).toEqual([])
    expect(FakeWs.all).toEqual([])
  })

  it('Disable while the URL is resolving leaves no WebSocket; stale sockets spawn nothing after re-enable', async () => {
    const url = deferred<string>()
    const mb = bridge([{ profile: 'alice', url: () => url.promise }])
    await mb.setEnabled(true)
    await mb.setEnabled(false)
    url.resolve('ws://gw/bridge')
    await flush()
    expect(FakeWs.all).toEqual([])

    const live = bridge()
    await live.setEnabled(true)
    const old = FakeWs.all[0]
    old.open()
    await live.setEnabled(false)
    await live.setEnabled(true)
    const before = procs.length
    old.onmessage?.({ data: JSON.stringify({ t: 'open', c: 'stale' }) })
    expect(procs.length).toBe(before)
    expect((await live.status()).inUse).toEqual([])
  })

  it('close code 4000 (another Mac took over) is terminal until Enable is toggled', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()
    FakeWs.all[0].frame({ t: 'open', c: 'c1' })
    FakeWs.all[0].close(REPLACED_CODE)

    expect(children()[0].proc.killed).toBe(true)
    expect(timers.map(timer => timer.ms)).toEqual([30_000]) // the retarget tick only: no redial
    const status = await mb.status()
    expect(status.connections).toEqual([{ profile: 'alice', state: 'replaced', error: REPLACED_TEXT }])
    await mb.retarget()
    expect(FakeWs.all).toHaveLength(1)

    await mb.setEnabled(false)
    await mb.setEnabled(true)
    expect(FakeWs.all).toHaveLength(2)
  })

  it('carries a 70 KB call and an 8 MB result intact, and answers an over-limit result with an error', async () => {
    const mb = bridge(undefined, { maxMessageBytes: 9 * 1024 * 1024 })
    await mb.setEnabled(true)
    const ws = FakeWs.all[0]
    ws.open()
    ws.frame({ t: 'open', c: 'c1' })
    const child = children()[0].proc

    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'type_text', arguments: { text: 'k'.repeat(70_000) } }
    }

    ws.frame({ t: 'msg', c: 'c1', m: call })
    expect(child.written).toEqual([call])

    const big = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'image', data: 'A'.repeat(8 * 1024 * 1024), mimeType: 'image/png' }] }
    }

    const line = Buffer.from(`${JSON.stringify(big)}\n`)

    for (let at = 0; at < line.length; at += 65_536) {
      child.stdout.emit('data', line.subarray(at, at + 65_536))
    }

    expect(ws.sent.at(-1)).toEqual({ t: 'msg', c: 'c1', m: big })

    const huge = { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'B'.repeat(10 * 1024 * 1024) }] } }
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(huge)}\n`))
    expect(ws.sent.at(-1).m).toMatchObject({ id: 2, error: { code: -32000 } })
  })

  it('keeps a multibyte character split across two chunks intact', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()
    FakeWs.all[0].frame({ t: 'open', c: 'c1' })
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { text: 'café ✓' } })}\n`)
    const cut = bytes.indexOf(Buffer.from('é')) + 1 // between the two bytes of é
    children()[0].proc.stdout.emit('data', bytes.subarray(0, cut))
    children()[0].proc.stdout.emit('data', bytes.subarray(cut))
    expect(FakeWs.all[0].sent.at(-1).m.result.text).toBe('café ✓')
  })
})

describe('review round 3: a daemon that becomes ready after Disable or quit is still stopped', () => {
  // Real processes: the real reaper (/bin/sh) and a stand-in daemon whose argv is `… serve … --socket <sock> …`.
  const live: any[] = []
  const alive = (proc: any) => proc.exitCode === null && proc.signalCode === null
  const exited = (proc: any) => (alive(proc) ? new Promise(done => proc.once('exit', done)) : Promise.resolve())

  const fakeDaemon = (argv: string[]) => {
    const proc = spawnReal(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...argv], { stdio: 'ignore' })
    live.push(proc)

    return proc
  }

  afterEach(() => {
    for (const proc of live.splice(0)) {
      if (alive(proc)) {
        proc.kill('SIGKILL')
      }
    }
  })

  /** A bridge whose `open` launches the stand-in daemon after `readyAfterMs`; reapers run for real. */
  function lateBridge(readyAfterMs: number, stopWorks = true) {
    const state: { daemon: any; reapers: any[]; unrefs: number } = { daemon: null, reapers: [], unrefs: 0 }

    const mb = bridge(undefined, {
      spawn: (command, args, options) => {
        if (command === '/bin/sh') {
          const proc = spawnReal(command, args, options)
          const unref = proc.unref.bind(proc)
          proc.unref = () => ((state.unrefs += 1), unref())
          state.reapers.push({ proc, options })
          live.push(proc)

          return proc
        }

        const proc = new FakeProc()
        procs.push({ command, args, options, proc })

        return proc
      },
      run: async (command, args, options) => {
        runs.push({ command, args, options })

        if (command === '/usr/bin/codesign') {
          return { code: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\n' }
        }

        if (command === '/usr/bin/open') {
          const argv = args.slice(args.indexOf('--args') + 1)
          const launch = () => (state.daemon = fakeDaemon(argv))
          readyAfterMs ? setTimeout(launch, readyAfterMs) : launch()
        }

        const up = args[0] === 'status' && state.daemon && alive(state.daemon)

        return { code: args[0] === 'status' && !up ? 1 : 0, stdout: '', stderr: '' }
      },
      runSync: (command, args) => {
        syncRuns.push({ command, args })

        return stopWorks
      }
    })

    return { mb, state }
  }

  const untilLaunched = async (state: { daemon: any }) => {
    while (!state.daemon) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  it('ready at 6 s, Disable at once: the reaper kills it; nothing stays running', async () => {
    const { mb, state } = lateBridge(6000)
    void mb.setEnabled(true)
    await flush()
    const off = await mb.setEnabled(false)
    expect(off.daemon.running).toBe(false)
    expect(state.reapers).toHaveLength(1)
    expect(state.reapers[0].options).toMatchObject({ detached: true })

    const t0 = Date.now()
    await untilLaunched(state)
    await exited(state.daemon)
    expect(state.daemon.signalCode).toBe('SIGTERM')
    expect(Date.now() - t0).toBeLessThan(8000)
    await exited(state.reapers[0].proc)
  }, 20_000)

  it('ready at 6 s, quit at once: the detached reaper (unref’d, outlives quit) kills it', async () => {
    const { mb, state } = lateBridge(6000)
    void mb.setEnabled(true)
    await flush()
    mb.stopSync() // main's will-quit
    expect(state.reapers).toHaveLength(1)
    expect(state.reapers[0].options).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(state.unrefs).toBe(1)

    await untilLaunched(state)
    await exited(state.daemon)
    expect(state.daemon.signalCode).toBe('SIGTERM')
    await exited(state.reapers[0].proc)
  }, 20_000)

  it('a failed `cua-driver stop` still ends in the pid kill', async () => {
    const { mb, state } = lateBridge(0, false)
    await mb.setEnabled(true)
    expect((await mb.status()).daemon.running).toBe(true)
    await mb.setEnabled(false)
    expect(stops()).toHaveLength(1)
    await exited(state.daemon)
    expect(state.daemon.signalCode).toBe('SIGTERM')
  }, 20_000)

  it('matches only `serve` on the exact socket path (positive and negative controls)', async () => {
    const sock = path.join(dir, 'evaos-cua-0123456789ab.sock')
    const ours = fakeDaemon(['serve', '--embedded', '--socket', sock, '--no-permissions-gate'])
    const longer = fakeDaemon(['serve', '--embedded', '--socket', `${sock}2`])
    const sibling = fakeDaemon(['serve', '--embedded', '--socket', path.join(dir, 'evaos-cua-0123456789ac.sock')])
    const shorter = fakeDaemon(['serve', '--embedded', '--socket', sock.slice(0, -5)])
    const child = fakeDaemon(['mcp', '--embedded', '--socket', sock])
    const [command, args] = reaperArgs(sock, Date.now() + 3000)
    const reaper = spawnReal(command, args, { stdio: 'ignore' })
    live.push(reaper)

    await exited(ours)
    await exited(reaper)
    expect(ours.signalCode).toBe('SIGTERM')

    for (const other of [longer, sibling, shorter, child]) {
      expect(alive(other)).toBe(true)
    }
  }, 20_000)
})

describe('pilot fix round 1', () => {
  const statePath = () => path.join(dir, 'mac-bridge.json')
  const saved = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'))

  /** Run (and drop) the newest pending timer of `ms`. */
  const fire = (ms: number) => {
    const timer = timers.filter(entry => entry.ms === ms).at(-1)

    if (!timer) {
      throw new Error(`no ${ms} ms timer (have ${timers.map(entry => entry.ms).join(', ')})`)
    }

    timers = timers.filter(entry => entry !== timer)
    timer.fn()
  }

  it('M2: three dials that never open drop a never-opened link to the long backoff, with the page text', async () => {
    const mb = bridge([{ profile: 'jane', url: async () => 'ws://gw/bridge' }])
    await mb.setEnabled(true)
    FakeWs.all[0].close(1006) // the relay refused the upgrade (the gateway answered 403)
    fire(1000)
    await flush()
    FakeWs.all[1].close(1006)
    fire(2000)
    await flush()
    FakeWs.all[2].close(1006)

    expect(timers.map(timer => timer.ms)).toContain(LONG_BACKOFF_MS)
    expect(timers.map(timer => timer.ms)).not.toContain(4000)
    const [link] = (await mb.status()).connections
    expect(link).toEqual({ profile: 'jane', state: 'retrying', error: notSetUpText('jane') })
    expect(link.error).toBe("Computer Use isn't set up for jane yet")

    // A sign-in starts over at once, without waiting out the 10 min.
    await mb.signedIn()
    expect(FakeWs.all).toHaveLength(4)
    expect(timers.map(timer => timer.ms)).not.toContain(LONG_BACKOFF_MS)
  })

  it('M2: a link that has opened before keeps the normal backoff (a gateway restart is not "not set up")', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()
    FakeWs.all[0].close(1006)

    for (const [index, ms] of [1000, 2000, 4000, 8000].entries()) {
      fire(ms)
      await flush()
      FakeWs.all[index + 1].close(1006)
    }

    expect(timers.map(timer => timer.ms)).toContain(16_000)
    expect(timers.map(timer => timer.ms)).not.toContain(LONG_BACKOFF_MS)
  })

  it('M3: pings every 20 s; after a pong, 45 s of silence redials (not terminal)', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    const ws = FakeWs.all[0]
    ws.open()
    ws.frame({ t: 'open', c: 'c1' })

    clock += 20_000
    fire(20_000)
    expect(ws.sent.at(-1)).toEqual({ t: 'ping' })
    ws.frame({ t: 'pong' })

    // An inbound frame 30 s later pushes the deadline out.
    clock += 30_000
    ws.frame({ t: 'something-new' }) // unknown frames are ignored, but they are inbound
    clock += 15_000
    fire(SILENCE_MS) // 15 s since the last frame: re-armed for the remaining 30 s
    expect(ws.closed).toBe(false)

    clock += 30_000
    fire(30_000) // the newest 30 s timer is the watchdog (the other is the retarget tick)
    expect(ws.closed).toBe(true)
    expect(children()[0].proc.killed).toBe(true)
    expect((await mb.status()).connections[0].state).toBe('retrying')

    fire(1000)
    await flush()
    expect(FakeWs.all).toHaveLength(2)
    FakeWs.all[1].open()
    expect((await mb.status()).connections[0].state).toBe('connected')
  })

  it('M3: against a hub that never pongs, silence alone never drops the link', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()

    for (let tick = 0; tick < 5; tick += 1) {
      clock += 20_000
      fire(20_000)
    }

    expect(timers.map(timer => timer.ms)).not.toContain(SILENCE_MS)
    expect(FakeWs.all[0].closed).toBe(false)
    expect((await mb.status()).connections[0].state).toBe('connected')
  })

  it('M3: resume / unlock redials every link at once', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()
    FakeWs.all[0].frame({ t: 'open', c: 'c1' })

    mb.redial()
    await flush()
    expect(FakeWs.all[0].closed).toBe(true)
    expect(children()[0].proc.killed).toBe(true)
    expect(FakeWs.all).toHaveLength(2)
    FakeWs.all[1].open()
    expect(FakeWs.all[1].sent[0].t).toBe('hello')
  })

  it('M4: enabled by A, signed in as B: no dial and the switch shows off; back to A dials without a toggle', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    expect(saved()).toMatchObject({ enabled: true, account: ACCOUNT_A })
    FakeWs.all[0].open()

    signedInAs = ACCOUNT_B
    fire(30_000) // the retarget tick
    await flush()
    expect(FakeWs.all[0].closed).toBe(true)
    expect(FakeWs.all).toHaveLength(1)
    let status = await mb.status()
    expect(status.enabled).toBe(false)
    expect(status.connections).toEqual([])
    expect(status.daemon.running).toBe(true) // kept for A

    signedInAs = ACCOUNT_A
    fire(30_000)
    await flush()
    expect(FakeWs.all).toHaveLength(2)
    status = await mb.status()
    expect(status.enabled).toBe(true)

    // B turning it on makes it B's switch.
    signedInAs = ACCOUNT_B
    await mb.setEnabled(true)
    expect(saved()).toMatchObject({ enabled: true, account: ACCOUNT_B })
    expect((await mb.status()).enabled).toBe(true)
  })

  it('M4: sign-out closes the links at once and keeps the daemon and the saved switch', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()
    FakeWs.all[0].frame({ t: 'open', c: 'c1' })

    signedInAs = null // main calls retarget() right after signOut()
    await mb.retarget()
    expect(FakeWs.all[0].closed).toBe(true)
    expect(children()[0].proc.killed).toBe(true)
    expect(stops()).toEqual([])
    expect(saved()).toMatchObject({ enabled: true, account: ACCOUNT_A })
  })

  it('M4: a legacy {enabled:true} file (no account) is off', async () => {
    fs.writeFileSync(statePath(), JSON.stringify({ enabled: true }))
    const mb = bridge()
    await mb.init()
    expect(runs.filter(entry => entry.command === '/usr/bin/open')).toEqual([])
    expect((await mb.status()).enabled).toBe(false)
  })

  it('S1: a failed target lookup keeps the current links', async () => {
    let failing = false

    const mb = bridge(undefined, {
      resolveTargets: async () => {
        if (failing) {
          throw new Error('broker unreachable')
        }

        return [{ profile: 'alice', url: async () => 'ws://gw/bridge' }]
      }
    })

    await mb.setEnabled(true)
    FakeWs.all[0].open()
    failing = true
    await mb.retarget()
    const status = await mb.status()
    expect(FakeWs.all[0].closed).toBe(false)
    expect(status.connections).toEqual([{ profile: 'alice', state: 'connected', error: null }])
    expect(status.error).toBe('broker unreachable')
  })

  it('S2: an open alone does not reset the backoff; a first frame or 60 s open does', async () => {
    const mb = bridge()
    await mb.setEnabled(true)
    FakeWs.all[0].open()
    FakeWs.all[0].close(1006) // accepted, then dropped at once (a failing hub)
    fire(1000)
    await flush()
    FakeWs.all[1].open()
    FakeWs.all[1].close(1006)
    expect(timers.map(timer => timer.ms)).toContain(2000) // not back to 1 s

    fire(2000)
    await flush()
    FakeWs.all[2].open()
    FakeWs.all[2].frame({ t: 'pong' })
    FakeWs.all[2].close(1006)
    expect(timers.map(timer => timer.ms)).toContain(1000)

    fire(1000)
    await flush()
    FakeWs.all[3].open()
    fire(60_000)
    FakeWs.all[3].close(1006)
    expect(timers.filter(timer => timer.ms === 1000)).toHaveLength(1)
  })

  it('S3: a failed start retries at 30 s, 60 s, then every 5 min while enabled', async () => {
    const mb = bridge(undefined, {
      run: async (command, args, options) => {
        runs.push({ command, args, options })

        return { code: 0, stdout: '', stderr: command === '/usr/bin/codesign' ? 'Identifier=com.example\n' : '' }
      }
    })

    expect((await mb.setEnabled(true)).error).toMatch(/not CUA's signed/)
    const delays: number[] = []

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pending = timers.find(timer => [30_000, 60_000, 300_000].includes(timer.ms))!
      delays.push(pending.ms)
      fire(pending.ms)
      await flush()
      await flush()
    }

    expect(delays).toEqual([30_000, 60_000, 300_000, 300_000])
    await mb.setEnabled(false)
    expect(timers).toEqual([])
  })

  it('S3: the 30 s tick restarts a private daemon that stopped answering and re-sends hello', async () => {
    let dead = ''

    const mb = bridge(undefined, {
      run: async (command, args, options) => {
        runs.push({ command, args, options })

        if (command === '/usr/bin/codesign') {
          return { code: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\n' }
        }

        return { code: args[0] === 'status' && args[2] === dead ? 1 : 0, stdout: '', stderr: '' }
      }
    })

    await mb.setEnabled(true)
    const ws = FakeWs.all[0]
    ws.open()
    ws.frame({ t: 'open', c: 'c1' })
    dead = runs.find(entry => entry.command === '/usr/bin/open')!.args[8]

    fire(30_000)

    for (let i = 0; i < 5; i += 1) {
      await flush()
    }

    const opens = runs.filter(entry => entry.command === '/usr/bin/open')
    expect(opens).toHaveLength(2)
    expect(opens[1].args[8]).not.toBe(dead)
    expect(stops()).toEqual([{ command: binary, args: ['stop', '--socket', dead] }])
    expect(children()[0].proc.killed).toBe(true)
    expect(ws.sent.filter(frame => frame.t === 'hello')).toHaveLength(2)
    expect(ws.closed).toBe(false)
    // Our own socket only: the user's daemon is never asked about or stopped.
    expect(runs.filter(entry => entry.args[0] === 'status').every(entry => entry.args[1] === '--socket')).toBe(true)
  })

  it('S4: the daemon socket is saved before launch and reaped at the next start after a crash', async () => {
    let onDisk: any = null

    const mb = bridge(undefined, {
      run: async (command, args, options) => {
        runs.push({ command, args, options })

        if (command === '/usr/bin/open') {
          onDisk = saved()
        }

        if (command === '/usr/bin/codesign') {
          return { code: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\n' }
        }

        return { code: 0, stdout: '', stderr: '' }
      }
    })

    await mb.setEnabled(true)
    const sock = runs.find(entry => entry.command === '/usr/bin/open')!.args[8]
    expect(onDisk.daemonSocket).toBe(sock)
    expect(saved().daemonSocket).toBe(sock)

    // The app crashes (no will-quit): the next run reaps that exact path before starting.
    procs = []
    const next = bridge()
    await next.init()
    const reaper = procs.find(entry => entry.command === '/bin/sh')!
    expect(reaper.args.slice(0, 4)).toEqual(reaperArgs(sock, 0)[1].slice(0, 4))
    expect(reaper.options).toMatchObject({ detached: true })
    const newSock = runs.filter(entry => entry.command === '/usr/bin/open').at(-1)!.args[8]
    expect(newSock).not.toBe(sock)
    expect(saved().daemonSocket).toBe(newSock)

    next.stopSync()
    expect(saved().daemonSocket).toBeUndefined()
  })
})
