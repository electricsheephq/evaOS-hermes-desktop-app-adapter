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
  onclose?: () => void
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

  close() {
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }
}

let dir: string
let procs: { command: string; args: string[]; options: any; proc: FakeProc }[]
let runs: { command: string; args: string[]; options: any }[]
let syncRuns: { command: string; args: string[] }[]
let timers: { fn: () => void; ms: number }[]
let binary: string

function bridge(targets = [{ profile: 'alice', url: async () => 'ws://gw/api/plugins/computer-use/bridge?token=t' }]) {
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
    runSync: (command, args) => void syncRuns.push({ command, args }),
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
    clearTimer: timer => void (timers = timers.filter(entry => entry !== timer))
  })
}

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
    expect(syncRuns).toEqual([{ command: binary, args: ['stop', '--socket', sock] }])
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
    freshWsUrl: async ({ path: p, profile }: { path: string; profile: string }) =>
      `ws://127.0.0.1:9/${profile}${p}?ticket=x`
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

    // Support starting between two dials is caught at the dial.
    let delegated: null | string[] = null
    const live = { ...eva(), delegatedProfiles: async () => delegated }
    const [target] = await resolveMacBridgeTargets({ managed: true, eva: live })
    delegated = ['customer']
    await expect(target.url()).rejects.toThrow(/delegated support/)
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
