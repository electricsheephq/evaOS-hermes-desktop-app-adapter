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
  MAC_BRIDGE_PATH,
  REPLACED_CODE,
  REPLACED_TEXT,
  resolveMacBridgeTargets,
  serveArgs
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
    log: () => undefined,
    candidates: [binary],
    tmpdir: dir,
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
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'mac-bridge.json'), 'utf8'))).toEqual({ enabled: false })
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
    authorizedProfiles: async () => ['alice', 'alice-work'],
    ownProfileWsUrl: async ({ path: p, profile }: { path: string; profile: string }) => {
      if (overrides.supportStarted?.()) {
        throw new Error('This profile is not one of your own agents.')
      }

      return `ws://127.0.0.1:9/${profile}${p}?ticket=x`
    }
  })

  it('opens one bridge per profile the signed-in user owns, through the relay', async () => {
    const targets = await resolveMacBridgeTargets({ managed: true, eva: eva() })
    expect(targets.map(target => target.profile)).toEqual(['alice', 'alice-work'])
    expect(await targets[1].url()).toBe(`ws://127.0.0.1:9/alice-work${MAC_BRIDGE_PATH}?ticket=x`)
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
