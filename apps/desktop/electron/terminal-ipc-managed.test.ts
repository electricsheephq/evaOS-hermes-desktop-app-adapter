import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  pty: {
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    pid: 123,
    resize: vi.fn(),
    write: vi.fn()
  },
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getVersion: () => 'test'
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)
  }
}))
vi.mock('node-pty', () => ({ default: { spawn: mocks.spawn } }))
vi.mock('./connection-apply', () => ({ resolveTerminalConnectionForSender: vi.fn(async () => null) }))
vi.mock('./spawn-helper-perms', () => ({ ensureSpawnHelperExecutable: vi.fn(() => ({ errors: [], fixed: [] })) }))

import { registerTerminalIpc } from './terminal-ipc'

const invoke = (channel: string, event: unknown, ...args: unknown[]) => {
  const handler = mocks.handlers.get(channel)
  expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')

  return Promise.resolve().then(() => handler?.(event, ...args))
}

// A managed build talks to a URL remote, so there is no SSH target and the
// embedded terminal is a local PTY on this computer, as upstream does it. The
// managed denials are offered here exactly as main.ts used to wire them; they
// must not be consulted.
describe('registerTerminalIpc in the managed build', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.spawn.mockReset().mockReturnValue(mocks.pty)
    Object.values(mocks.pty).forEach(value => typeof value === 'function' && vi.mocked(value).mockClear())

    registerTerminalIpc({
      activeSshTerminalTarget: () => null,
      assertLocalMutationAllowed: () => {
        throw new Error('managed local terminal mutation blocked')
      },
      assertLocalTerminalAllowed: () => {
        throw new Error('managed local terminal blocked')
      },
      ensureBackend: async () => null,
      findOnPath: () => null,
      getSshConnectionState: () => undefined,
      isWindows: false,
      rememberLog: () => undefined
    } as Parameters<typeof registerTerminalIpc>[0])
  })

  it('starts, drives and disposes a local terminal', async () => {
    const sender = { id: 7, isDestroyed: () => false, once: vi.fn(), send: vi.fn() }
    const started = (await invoke('hermes:terminal:start', { sender }, {})) as { id: string; shell: string }

    expect(started.id).toBeTypeOf('string')
    expect(started.shell).not.toBe('ssh')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn.mock.calls[0]?.[0]).not.toBe('ssh')

    await expect(invoke('hermes:terminal:write', {}, started.id, 'ls\n')).resolves.toBe(true)
    expect(mocks.pty.write).toHaveBeenCalledWith('ls\n')
    await expect(invoke('hermes:terminal:resize', {}, started.id, { cols: 100, rows: 30 })).resolves.toBe(true)
    expect(mocks.pty.resize).toHaveBeenCalledWith(100, 30)
    await expect(invoke('hermes:terminal:dispose', {}, started.id)).resolves.toBe(true)
    expect(mocks.pty.kill).toHaveBeenCalledTimes(1)
  })
})
