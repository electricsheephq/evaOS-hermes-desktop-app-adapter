/**
 * Computer Use — the left-sidebar page for the Mac bridge (`electron/mac-bridge.ts`):
 * whether CUA is installed and permitted on this Mac, the one Enable switch, and
 * which of the user's agents are connected and using it right now.
 */

import {
  Badge,
  Button,
  type HermesPlugin,
  ListRow,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution,
  ToggleRow
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

type MacBridgeStatus = Awaited<ReturnType<NonNullable<Window['hermesDesktop']['macBridge']>['status']>>

const PATH = '/computer-use'
const POLL_MS = 2000

function granted(value: boolean | null | undefined) {
  return (
    <Badge variant={value ? 'success' : 'muted'}>
      {value ? 'Granted' : value === false ? 'Not granted' : 'Unknown'}
    </Badge>
  )
}

function ago(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))

  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`
}

export function ComputerUsePage() {
  const bridge = window.hermesDesktop?.macBridge
  const [status, setStatus] = useState<MacBridgeStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!bridge) {
      return
    }

    let live = true
    const read = () => void bridge.status().then(next => live && setStatus(next))
    read()
    const timer = window.setInterval(read, POLL_MS)

    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [bridge])

  const toggle = async (on: boolean) => {
    setBusy(true)

    try {
      setStatus(await bridge!.setEnabled(on))
    } finally {
      setBusy(false)
    }
  }

  const connected = status?.connections.filter(link => link.state === 'connected') ?? []

  return (
    <section className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-6 px-[clamp(1.25rem,4vw,4rem)] py-8">
        <header className="grid gap-2">
          <h1 className="text-lg font-semibold">Computer Use</h1>
          <p className="text-sm text-muted-foreground">
            Your agents can operate this Mac in the background while the app is running — from this chat, Telegram, or a
            scheduled job, several at once. They use CUA on this Mac, never the server. Turn off to stop.
          </p>
        </header>

        {!bridge || !status ? (
          <p className="text-sm text-muted-foreground">Checking this Mac…</p>
        ) : (
          <div className="grid">
            <ListRow
              action={
                <Button onClick={() => void bridge.installCua()} size="sm" variant="outline">
                  {status.cua.found ? 'Reinstall CUA' : 'Install CUA'}
                </Button>
              }
              description={
                status.cua.found ? `${status.cua.path} (${status.cua.source})` : 'CUA is not installed on this Mac yet.'
              }
              title={status.cua.found ? `CUA ${status.cua.version ?? ''} found` : 'CUA not found'}
            />
            <ListRow
              action={
                <Button
                  disabled={!status.cua.found}
                  onClick={() => void bridge.grantPermissions()}
                  size="sm"
                  variant="outline"
                >
                  Grant permissions
                </Button>
              }
              description={
                <span className="flex flex-wrap items-center gap-2">
                  Accessibility {granted(status.permissions?.accessibility)} Screen Recording{' '}
                  {granted(status.permissions?.screen_recording)}
                </span>
              }
              title="macOS permissions"
            />
            <ToggleRow
              checked={status.enabled}
              description={
                status.error ??
                (status.daemon.running ? `CUA is running for your agents (${status.daemon.mode}).` : 'Off.')
              }
              disabled={busy || (!status.cua.found && !status.enabled)}
              label="Enable Computer Use"
              onChange={on => void toggle(on)}
            />
            <ListRow
              description={
                connected.length
                  ? connected.map(link => link.profile).join(', ')
                  : status.enabled
                    ? 'Connecting…'
                    : 'Not connected.'
              }
              title="Connected to"
            />
            <ListRow
              description={
                status.inUse.length ? (
                  <span className="grid gap-1">
                    {status.inUse.map(use => (
                      <span key={use.conn}>
                        {use.profile} · agent connection {use.conn.slice(0, 6)} · last action {ago(use.lastActivity)}
                      </span>
                    ))}
                  </span>
                ) : (
                  'No agent is using this Mac right now.'
                )
              }
              title="In use by"
            />
          </div>
        )}
      </div>
    </section>
  )
}

const plugin: HermesPlugin = {
  id: 'computer-use',
  name: 'Computer Use',
  description: 'Lets your agents operate this Mac in the background through CUA while the app runs.',
  register(ctx) {
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PATH } satisfies RouteContribution,
        render: () => <ComputerUsePage />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 40,
        data: { codicon: 'device-desktop', label: 'Computer Use', path: PATH } satisfies SidebarNavContribution
      }
    ])
  }
}

export default plugin
