import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawn: vi.fn(() => ({
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    pid: 123,
    resize: vi.fn(),
    write: vi.fn()
  }))
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

describe('registerTerminalIpc managed boundary', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.spawn.mockClear()
  })

  it('rejects local terminal creation and control before touching a PTY', async () => {
    const startBlocked = new Error('managed local terminal blocked')
    const mutationBlocked = new Error('managed local terminal mutation blocked')

    const deps = {
      activeSshTerminalTarget: () => null,
      assertLocalMutationAllowed: () => {
        throw mutationBlocked
      },
      assertLocalTerminalAllowed: () => {
        throw startBlocked
      },
      ensureBackend: async () => null,
      findOnPath: () => null,
      getSshConnectionState: () => undefined,
      isWindows: false,
      rememberLog: () => undefined
    }

    registerTerminalIpc(deps as Parameters<typeof registerTerminalIpc>[0])

    const sender = { id: 7, isDestroyed: () => false, once: vi.fn(), send: vi.fn() }
    const start = mocks.handlers.get('hermes:terminal:start')

    expect(start).toBeTypeOf('function')
    await expect(Promise.resolve().then(() => start?.({ sender }, {}))).rejects.toBe(startBlocked)
    expect(mocks.spawn).not.toHaveBeenCalled()

    for (const [channel, args] of [
      ['hermes:terminal:write', ['missing', 'text']],
      ['hermes:terminal:resize', ['missing', { cols: 80, rows: 24 }]],
      ['hermes:terminal:dispose', ['missing']]
    ] as Array<[string, unknown[]]>) {
      const handler = mocks.handlers.get(channel)

      expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')
      await expect(Promise.resolve().then(() => handler?.({}, ...args))).rejects.toBe(mutationBlocked)
    }
  })
})
