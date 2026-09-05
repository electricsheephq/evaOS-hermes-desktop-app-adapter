import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(async () => ({ ok: true })) }))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, sendSync: vi.fn(() => ({})) },
  webFrame: {},
  webUtils: {}
}))

import './preload'

const bridge = mocks.expose.mock.calls.find(([name]) => name === 'hermesDesktop')![1]

beforeEach(() => mocks.invoke.mockClear())

it('preserves the managed profile and plugin endpoint through the real preload bridge', async () => {
  await bridge.getGatewayWsUrl('synthetic-profile', '/api/plugins/synthetic/events')
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
    'hermes:gateway:ws-url',
    'synthetic-profile',
    '/api/plugins/synthetic/events'
  )
})

it('keeps managed media resolution in the native process', async () => {
  await bridge.getMediaStreamUrl('synthetic-media.mp4', 'synthetic-profile')
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
    'hermes:media:stream-url',
    'synthetic-media.mp4',
    'synthetic-profile'
  )
})

it('keeps managed enrollment status on its existing IPC channel', async () => {
  await bridge.eva.status()
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('hermes:eva:status')
})
