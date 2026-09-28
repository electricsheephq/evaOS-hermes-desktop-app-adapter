import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HermesGateway } from './client'

class FakeWebSocket extends EventTarget {
  static OPEN = 1
  static instances: FakeWebSocket[] = []

  readyState = 0
  sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close'))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  respond(id: string, result: unknown = {}): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, jsonrpc: '2.0', result }) }))
  }

  lastRequest(): { id: string; method: string; params: Record<string, unknown> } {
    return JSON.parse(this.sent.at(-1) ?? '{}')
  }
}

describe('HermesGateway Desktop UI protocol contract', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['session.create', 'session.resume', 'session.activate'])('adds protocol 3 to %s', async method => {
    const gateway = new HermesGateway()
    const connecting = gateway.connect('ws://gateway.invalid')
    const socket = FakeWebSocket.instances[0]
    socket.open()
    await connecting

    const response = gateway.request(method, { session_id: 'synthetic-session', source: 'desktop' })
    const request = socket.lastRequest()

    expect(request.params).toEqual({
      desktop_ui_protocol: 3,
      session_id: 'synthetic-session',
      source: 'desktop'
    })

    socket.respond(request.id)
    await response
    gateway.close()
  })

  it('does not mark unrelated requests', async () => {
    const gateway = new HermesGateway()
    const connecting = gateway.connect('ws://gateway.invalid')
    const socket = FakeWebSocket.instances[0]
    socket.open()
    await connecting

    const response = gateway.request('prompt.submit', { session_id: 'synthetic-session', source: 'desktop' })
    const request = socket.lastRequest()

    expect(request.params).toEqual({ session_id: 'synthetic-session', source: 'desktop' })

    socket.respond(request.id)
    await response
    gateway.close()
  })

  it('sends managed billing reads and rejects managed spend calls before the socket', async () => {
    const desktopWindow = window as { hermesDesktop?: unknown }
    const previousDesktop = desktopWindow.hermesDesktop
    desktopWindow.hermesDesktop = { eva: {} }

    try {
      const gateway = new HermesGateway()
      const connecting = gateway.connect('ws://gateway.invalid')
      const socket = FakeWebSocket.instances[0]
      socket.open()
      await connecting

      for (const method of ['usage.bars', 'subscription.state']) {
        const response = gateway.request(method)
        const request = socket.lastRequest()

        expect(request.method).toBe(method)

        socket.respond(request.id)
        await response
      }

      const sentBeforeSpend = socket.sent.length

      // request() throws synchronously; callers that await it see a rejection.
      await expect(Promise.resolve().then(() => gateway.request('billing.charge', { amount: 1 }))).rejects.toThrow(
        'Billing and subscription actions are unavailable in managed evaOS Agent.'
      )
      expect(socket.sent).toHaveLength(sentBeforeSpend)

      gateway.close()
    } finally {
      desktopWindow.hermesDesktop = previousDesktop
    }
  })
})
