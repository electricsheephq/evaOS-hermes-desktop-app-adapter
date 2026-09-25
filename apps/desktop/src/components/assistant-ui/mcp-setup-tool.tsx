'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import {
  connectionRequestOwnsPart,
  CONNECTOR_CARD_PHASES,
  MARK_LABEL,
  reissueConnectionTarget,
  useConnectionOwner,
  useConnectorFocusHandoff
} from '@/components/assistant-ui/connector-tool'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
<<<<<<< HEAD
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import {
  addMcpServer,
  getActionStatus,
  getMcpCatalog,
  installMcpCatalogEntry,
  type McpCatalogEntry,
  type ProfileScope,
  removeMcpServer,
  setMcpServerEnabled
} from '@/hermes'
||||||| 939e45c91d
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import {
  addMcpServer,
  getActionStatus,
  getMcpCatalog,
  installMcpCatalogEntry,
  type McpCatalogEntry,
  removeMcpServer,
  setMcpServerEnabled
} from '@/hermes'
=======
import { ConnectorCard, ConnectorRow, type ConnectorRowAction, ConnectorSummary } from '@/components/ui/connector-card'
import { SetupFormDialog } from '@/components/ui/setup-form-dialog'
>>>>>>> f97608f178
import { useI18n } from '@/i18n'
import { connectorText, type McpTarget, mcpTargets } from '@/lib/connector-tools'
import { Loader2 } from '@/lib/icons'
import { prettyName } from '@/lib/text'
import { cn } from '@/lib/utils'
import {
  type ConnectionOwner,
  type ConnectionRequest,
  type ConnectionTarget,
  type ConnectionTargetState,
  continueConnectionRequest,
  respondToConnectionRequest,
  sessionConnectionRequest
} from '@/store/connection-request'
import { notifyError } from '@/store/notifications'
import { assertSessionOwnerResolved } from '@/store/session-owner-resolution'
import { knownOwnerForSession, requestForOwnedSession } from '@/store/session-states'
import { invalidateMcpSuggestionIndex } from '@/store/suggestion-providers/mcp'

import { selectMessageRunning } from './tool/fallback-model'
import { parseMaybeObject } from './tool/fallback-model/format'

<<<<<<< HEAD
type SetupAction = 'authorize' | 'enable' | 'install'

interface SetupArgs {
  server: string
  action: SetupAction
  reason: string
}

const CATALOG_INSTALL_POLL_MS = 1500

// Thrown by the in-flight flow when the user cancels — the declined respond
// has already been sent, so the catch path must swallow this, not report it.
const CANCELLED = Symbol('mcp-setup-cancelled')

/** Resolve the capability REST scope from the session that owns the blocking
 * setup request. A real session never falls back to whichever gateway is in
 * the foreground; unknown ownership fails closed before configuration writes. */
function mcpSetupOwnerScope(sessionId: null | string): ProfileScope {
  const owner = knownOwnerForSession(sessionId)

  assertSessionOwnerResolved(owner, { method: 'mcp.setup', sessionId })

  if (owner && typeof owner === 'object') {
    return { connectionId: owner.connectionId, profile: owner.profile }
  }

  return owner
}

function readSetupArgs(args: unknown): SetupArgs {
  const row = parseMaybeObject(args)
  const rawAction = typeof row.action === 'string' ? row.action : 'install'

  return {
    action: rawAction === 'enable' || rawAction === 'authorize' ? rawAction : 'install',
    reason: typeof row.reason === 'string' ? row.reason : '',
    server: typeof row.server === 'string' ? row.server : ''
  }
}

/** The tool's settled JSON — the card's outcome plus the tool-only
 *  `unanswered` status (timeout, no user action). */
type SettledResult = Omit<Partial<McpSetupOutcome>, 'status'> & {
  status?: McpSetupOutcome['status'] | 'unanswered'
  note?: string
}

function readSetupResult(result: unknown): SettledResult {
  return parseMaybeObject(result) as SettledResult
}
||||||| 939e45c91d
type SetupAction = 'authorize' | 'enable' | 'install'

interface SetupArgs {
  server: string
  action: SetupAction
  reason: string
}

const CATALOG_INSTALL_POLL_MS = 1500

// Thrown by the in-flight flow when the user cancels — the declined respond
// has already been sent, so the catch path must swallow this, not report it.
const CANCELLED = Symbol('mcp-setup-cancelled')

function readSetupArgs(args: unknown): SetupArgs {
  const row = parseMaybeObject(args)
  const rawAction = typeof row.action === 'string' ? row.action : 'install'

  return {
    action: rawAction === 'enable' || rawAction === 'authorize' ? rawAction : 'install',
    reason: typeof row.reason === 'string' ? row.reason : '',
    server: typeof row.server === 'string' ? row.server : ''
  }
}

/** The tool's settled JSON — the card's outcome plus the tool-only
 *  `unanswered` status (timeout, no user action). */
type SettledResult = Omit<Partial<McpSetupOutcome>, 'status'> & {
  status?: McpSetupOutcome['status'] | 'unanswered'
  note?: string
}

function readSetupResult(result: unknown): SettledResult {
  return parseMaybeObject(result) as SettledResult
}
=======
type SetupAction = McpTarget['action']
type SetupCopy = ReturnType<typeof useI18n>['t']['assistant']['mcpSetup']
>>>>>>> f97608f178

const SHELL_CLASS = `${WIDGET_SHELL_CLASS} text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)`

const TITLE = {
  authorize: (copy: SetupCopy) => copy.authorizeTitle,
  enable: (copy: SetupCopy) => copy.enableTitle,
  install: (copy: SetupCopy) => copy.installTitle
} satisfies Record<SetupAction, (copy: SetupCopy) => string>

const VERB = {
  authorize: (copy: SetupCopy) => copy.authorizeAction,
  enable: (copy: SetupCopy) => copy.enableAction,
  install: (copy: SetupCopy) => copy.installAction
} satisfies Record<SetupAction, (copy: SetupCopy) => string>

const DONE = {
  authorize: (copy: SetupCopy, server: string) => copy.authorized(server),
  enable: (copy: SetupCopy, server: string) => copy.enabled(server),
  install: (copy: SetupCopy, server: string) => copy.installed(server)
} satisfies Record<SetupAction, (copy: SetupCopy, server: string) => string>

/** The row's one verb. `approve` is the user's consent, `working` is the backend acting on it, `open`
 *  is a sign-in link the backend already minted, `reissue` asks for a fresh attempt. */
type McpVerb = 'approve' | 'none' | 'open' | 'reissue' | 'working'

const MCP_VERBS = {
  connected: 'none',
  expired: 'reissue',
  failed: 'reissue',
  initiated: 'open',
  not_connected: 'none',
  pending: 'approve',
  skipped: 'none'
} satisfies Record<ConnectionTargetState, McpVerb>

// Two states read differently per action. A pending authorize is the backend still minting the link,
// so there is nothing for the user to consent to. An initiated row with a link is that link waiting
// to be opened, whatever the action: an install of an OAuth entry reaches it too. An initiated row
// with no link is the backend working.
const rowVerb = (target: ConnectionTarget, action: SetupAction): McpVerb => {
  if (action === 'authorize') {
    return target.state === 'pending' ? 'none' : MCP_VERBS[target.state]
  }

  if (target.state === 'initiated') {
    return target.connectUrl ? 'open' : 'working'
  }

  return MCP_VERBS[target.state]
}

function readSetupAction(args: unknown): SetupAction {
  const [target] = mcpTargets('manage_connections', parseMaybeObject(args))

  return target?.action ?? 'install'
}

interface SettledTarget {
  name: string
  state: string
  tools: number
  toolsUnavailable: boolean
}

/** A settled operation is a static per-target summary: one word per row, no controls. */
function McpSetupSummary({ action, rows }: { action: SetupAction; rows: SettledTarget[] }) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup

  return (
    <div className="my-2 grid min-w-0 max-w-lg gap-1" data-connector-offer>
      {rows.map(row => {
        const title = prettyName(row.name)
        const connected = row.state === 'connected'

        const line = connected
          ? row.toolsUnavailable
            ? `${DONE[action](copy, title)} · ${t.connectors.authorizedToolsUnavailable}`
            : DONE[action](copy, title)
          : row.state === 'skipped'
            ? t.connectors.skipped
            : t.connectors.notConnected

        return (
          <ConnectorSummary
            connector={{ name: row.name, title }}
            key={row.name}
            meta={connected && row.tools > 0 ? `${line} · ${copy.toolCount(row.tools)}` : line}
            tone={connected ? 'ok' : undefined}
          />
        )
      })}
    </div>
  )
}

function readSetupResult(result: unknown): SettledTarget[] {
  const row = parseMaybeObject(result)
  const targets = Array.isArray(row.targets) ? row.targets.map(parseMaybeObject) : []

  return targets.flatMap(target => {
    const name = connectorText(target.name)

    return name
      ? [
          {
            name,
            state: connectorText(target.state) ?? '',
            tools: Array.isArray(target.tools) ? target.tools.length : 0,
            toolsUnavailable: Boolean(connectorText(target.discovery_error))
          }
        ]
      : []
  })
}

export const McpSetupTool = (props: ToolCallMessagePartProps) => {
  if (props.result !== undefined) {
    return <McpSetupSettled {...props} />
  }

  return <McpSetupLive {...props} />
}

const McpSetupLive = (props: ToolCallMessagePartProps) => {
  const messageRunning = useAuiState(selectMessageRunning)

  if (!messageRunning) {
    return <ToolFallback {...props} />
  }

  return <McpSetupPending {...props} />
}

function McpSetupSettled({ args, result }: ToolCallMessagePartProps) {
  const action = useMemo(() => readSetupAction(args), [args])
  const rows = useMemo(() => readSetupResult(result), [result])

  return <McpSetupSummary action={action} rows={rows} />
}

export function McpSetupPending(props: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const view = useSessionView()
  // Use the rendering transcript's session, not the globally active one.
  const sessionId = useStore(view.$runtimeId)
  // Owner routes and hints are keyed by the stored id, not the runtime id the events carry.
  const storedId = useStore(view.$storedId)
  const $request = useMemo(() => sessionConnectionRequest(sessionId), [sessionId])
  const request = useStore($request)
  const action = useMemo(() => readSetupAction(props.args), [props.args])
  // The session's operation belongs to one tool call; another call's request never paints here.
  const live = connectionRequestOwnsPart(props, request)
  const owner = useConnectionOwner(storedId, live)

<<<<<<< HEAD
  const server = fromArgs.server || request?.server || ''
  const action: SetupAction = fromArgs.action ?? request?.action ?? 'install'
  const reason = fromArgs.reason || request?.reason || ''

  const [working, setWorking] = useState(false)
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [entry, setEntry] = useState<McpCatalogEntry | null | undefined>(undefined)
  const [envOpen, setEnvOpen] = useState(false)
  // Set when the user cancels mid-flight (a stuck OAuth tab, a hung install).
  // The in-flight flow checks it at every poll boundary and aborts via the
  // CANCELLED sentinel; the declined respond has already been sent by then.
  const cancelRef = useRef(false)

  // Race: tool.start fires a tick before mcp.setup.request — hold the buttons
  // until the gateway request is wired (same spinner rule as clarify).
  const ready = Boolean(request?.requestId)

  const respond = useCallback(
    async (outcome: McpSetupOutcome) => {
      // Another path (cancel racing completion) may have already resolved this
      // request; the store is the single source of truth, so bail if this
      // session's entry is gone — same guard as the approval bar.
      if (!request || sessionMcpSetupRequest(request.sessionId).get()?.requestId !== request.requestId) {
        return
      }

      if (!gateway) {
        notifyError(new Error(copy.gatewayDisconnected), copy.sendFailed)

        return
      }

      // Resolve before clearing the card. If ownership is missing, leave the
      // request visible and fail closed instead of sending to the foreground.
      try {
        mcpSetupOwnerScope(request.sessionId)
      } catch (error) {
        notifyError(error, copy.sendFailed)

        return
      }

      // Clear first: the answer is decided, and an in-flight RPC must not
      // leave a live card that can be answered a second time.
      clearMcpSetupRequest(request.requestId, request.sessionId)

      // A successful outcome changed mcp_servers — reload the live session
      // BEFORE unblocking the tool, or the agent resumes being told the
      // server is ready while its tool snapshot still lacks it (the same
      // write-through mcp-tab's silentReload does; consent was the card
      // click, so no confirm prompt). Reload failure isn't outcome failure:
      // the config landed, tools arrive next session — report it and move on.
      if (outcome.status === 'installed' || outcome.status === 'enabled' || outcome.status === 'authorized') {
        try {
          await requestForOwnedSession(
            request.sessionId,
            gateway.request.bind(gateway) as typeof gateway.request,
            'reload.mcp',
            { confirm: true, session_id: request.sessionId ?? undefined }
          )
        } catch (error) {
          notifyError(error, copy.reloadFailed)
        }

        // The just-set-up server must stop being suggested immediately.
        invalidateMcpSuggestionIndex()
      }

      try {
        await requestForOwnedSession<{ status?: string }>(
          request.sessionId,
          gateway.request.bind(gateway) as typeof gateway.request,
          'mcp.setup.respond',
          {
            request_id: request.requestId,
            result: JSON.stringify(outcome)
          }
        )
        // tool.complete lands next → McpSetupSettled.
      } catch (error) {
        notifyError(error, copy.sendFailed)
      }
    },
    [copy.gatewayDisconnected, copy.reloadFailed, copy.sendFailed, gateway, request]
  )

  const decline = useCallback(() => {
    // While a flow is in flight this is a CANCEL: answer declined right away
    // and let the abandoned work notice via cancelRef at its next poll.
    cancelRef.current = true
    triggerHaptic('cancel')
    void respond({ server, status: 'declined' })
  }, [respond, server])

  const approve = useCallback(async () => {
    cancelRef.current = false
    setWorking(true)

    // Poll-boundary abort for the background-install loop; the OAuth flows
    // carry their own cancel via completeMcpDesktopOAuth's `cancelled`.
    const throwIfCancelled = <T,>(value: T): T => {
      if (cancelRef.current) {
        throw CANCELLED
      }

      return value
    }

    try {
      const scope = mcpSetupOwnerScope(sessionId)

      if (action === 'enable') {
        await setMcpServerEnabled(server, true, scope)
        triggerHaptic('submit')
        await respond({ server, status: 'enabled' })

        return
      }

      if (action === 'authorize') {
        const flow = await completeMcpDesktopOAuth({
          serverName: server,
          profile: scope,
          cancelled: () => cancelRef.current
        })

        triggerHaptic('submit')
        await respond({ server, status: 'authorized', tools: (flow.tools ?? []).map(tool => tool.name) })

        return
      }

      // Install: prefer the reviewed catalog entry when one exists; otherwise
      // fall back to the desktop suggestion directory (official URL-only
      // remotes), written through the same validated POST the dashboard's add
      // form uses. Required catalog credentials get an inline prompt first
      // (never pre-filled, never echoed back).
      let resolved = entry

      if (resolved === undefined) {
        const catalog = await getMcpCatalog(scope)
        resolved = catalog.entries.find(candidate => candidate.name === server) ?? null
        setEntry(resolved)
      }

      if (!resolved) {
        const known = directoryEntry(server)

        if (!known) {
          await respond({ detail: copy.notInCatalog(server), server, status: 'error' })

          return
        }

        // URL-only remote: add to config, then run the OAuth/probe flow so
        // "Install" lands the user on a working server, not a 401. If the
        // flow dies after the config write (cancel, closed OAuth tab), roll
        // the write back — decline means "no server", not an unauthorized
        // entry squatting in mcp_servers (authoritative-write rule).
        await addMcpServer({ name: known.name, url: known.url }, scope)

        let flow

        try {
          flow = await completeMcpDesktopOAuth({
            serverName: known.name,
            profile: scope,
            cancelled: () => cancelRef.current
          })
        } catch (error) {
          await removeMcpServer(known.name, scope).catch(() => {
            // Rollback is best-effort; the primary error/cancel wins.
          })
          throw error
        }

        triggerHaptic('submit')
        await respond({ server, status: 'installed', tools: (flow.tools ?? []).map(tool => tool.name) })

        return
      }

      const required = resolved.required_env.filter(env => env.required)

      if (required.some(env => !envDraft[env.name]?.trim())) {
        // Reveal the credential fields; the user approves again once filled.
        setEnvOpen(true)

        return
      }

      const res = await installMcpCatalogEntry(server, envDraft, scope)

      // Git-backed entries clone in the background — poll to completion so a
      // non-zero exit surfaces as a real failure instead of a false success.
      if (res.background && res.action) {
        for (;;) {
          const status = throwIfCancelled(await getActionStatus(res.action, 1, scope))

          if (!status.running) {
            if (status.exit_code !== 0) {
              throw new Error(copy.failed(server))
            }

            break
          }

          await new Promise(resolve => setTimeout(resolve, CATALOG_INSTALL_POLL_MS))
        }
      }

      triggerHaptic('submit')
      await respond({ server, status: 'installed' })
    } catch (error) {
      // User cancel: the declined respond is already on the wire — the
      // abandoned flow just stops, nothing to report.
      if (error === CANCELLED || error instanceof McpOAuthCancelled) {
        return
      }

      notifyError(error, copy.failed(server))
      await respond({
        detail: error instanceof Error ? error.message : String(error),
        server,
        status: 'error'
      })
    } finally {
      setWorking(false)
    }
  }, [action, copy, entry, envDraft, respond, server, sessionId])

  const title =
    action === 'enable'
      ? copy.enableTitle(prettyName(server))
      : action === 'authorize'
        ? copy.authorizeTitle(prettyName(server))
        : copy.installTitle(prettyName(server))

  const actionLabel =
    action === 'enable' ? copy.enableAction : action === 'authorize' ? copy.authorizeAction : copy.installAction

  // What connecting actually means — the endpoint that will be contacted.
  // VS Code's trust dialog links the config it's about to trust; same idea.
  // Catalog entries carry their transport URL in the API response; the
  // static directory remains a fallback rung for older backends.
  const known = directoryEntry(server)
  const sourceLine = action === 'install' ? (entry?.url ?? known?.url ?? copy.catalogSource) : null
  const brand = brandFor(server)

  const trailingIcon = brand ? (
    <brand.Icon aria-hidden className="mt-px size-4 shrink-0" style={brandGlyphStyle(brand)} />
  ) : (
    <Codicon className={ICON_CLASS} name="plug" size="1rem" />
  )

  // ⌘/Ctrl+Enter → approve, Esc → decline/cancel. Same accelerators, same
  // guard shape as the approval bar (tool/approval.tsx). Unlike approve, Esc
  // stays live while a flow is in flight — that's the cancel path. Stands
  // down whenever a focusable control has focus (clarify's rule): a keystroke
  // meant for the composer, a popover, or the card's own credential fields
  // must never silently approve an install or throw away typed input.
  useEffect(() => {
    if (!ready) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      const active = document.activeElement as HTMLElement | null

      if (
        active &&
        (active.isContentEditable || active.matches('a[href], button, input, select, textarea, [role="button"]'))
      ) {
        return
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        if (!working) {
          event.preventDefault()
          void approve()
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        decline()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [approve, decline, ready, working])

  if (!ready) {
||||||| 939e45c91d
  const server = fromArgs.server || request?.server || ''
  const action: SetupAction = fromArgs.action ?? request?.action ?? 'install'
  const reason = fromArgs.reason || request?.reason || ''

  const [working, setWorking] = useState(false)
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [entry, setEntry] = useState<McpCatalogEntry | null | undefined>(undefined)
  const [envOpen, setEnvOpen] = useState(false)
  // Set when the user cancels mid-flight (a stuck OAuth tab, a hung install).
  // The in-flight flow checks it at every poll boundary and aborts via the
  // CANCELLED sentinel; the declined respond has already been sent by then.
  const cancelRef = useRef(false)

  // Race: tool.start fires a tick before mcp.setup.request — hold the buttons
  // until the gateway request is wired (same spinner rule as clarify).
  const ready = Boolean(request?.requestId)

  const respond = useCallback(
    async (outcome: McpSetupOutcome) => {
      // Another path (cancel racing completion) may have already resolved this
      // request; the store is the single source of truth, so bail if this
      // session's entry is gone — same guard as the approval bar.
      if (!request || sessionMcpSetupRequest(request.sessionId).get()?.requestId !== request.requestId) {
        return
      }

      if (!gateway) {
        notifyError(new Error(copy.gatewayDisconnected), copy.sendFailed)

        return
      }

      // Clear first: the answer is decided, and an in-flight RPC must not
      // leave a live card that can be answered a second time.
      clearMcpSetupRequest(request.requestId, request.sessionId)

      // A successful outcome changed mcp_servers — reload the live session
      // BEFORE unblocking the tool, or the agent resumes being told the
      // server is ready while its tool snapshot still lacks it (the same
      // write-through mcp-tab's silentReload does; consent was the card
      // click, so no confirm prompt). Reload failure isn't outcome failure:
      // the config landed, tools arrive next session — report it and move on.
      if (outcome.status === 'installed' || outcome.status === 'enabled' || outcome.status === 'authorized') {
        try {
          await gateway.request('reload.mcp', { confirm: true, session_id: request.sessionId ?? undefined })
        } catch (error) {
          notifyError(error, copy.reloadFailed)
        }

        // The just-set-up server must stop being suggested immediately.
        invalidateMcpSuggestionIndex()
      }

      try {
        await gateway.request<{ status?: string }>('mcp.setup.respond', {
          request_id: request.requestId,
          result: JSON.stringify(outcome)
        })
        // tool.complete lands next → McpSetupSettled.
      } catch (error) {
        notifyError(error, copy.sendFailed)
      }
    },
    [copy.gatewayDisconnected, copy.reloadFailed, copy.sendFailed, gateway, request]
  )

  const decline = useCallback(() => {
    // While a flow is in flight this is a CANCEL: answer declined right away
    // and let the abandoned work notice via cancelRef at its next poll.
    cancelRef.current = true
    triggerHaptic('cancel')
    void respond({ server, status: 'declined' })
  }, [respond, server])

  const approve = useCallback(async () => {
    cancelRef.current = false
    const oauthScope = capabilityScoped()
    setWorking(true)

    // Poll-boundary abort for the background-install loop; the OAuth flows
    // carry their own cancel via completeMcpDesktopOAuth's `cancelled`.
    const throwIfCancelled = <T,>(value: T): T => {
      if (cancelRef.current) {
        throw CANCELLED
      }

      return value
    }

    try {
      if (action === 'enable') {
        await setMcpServerEnabled(server, true)
        triggerHaptic('submit')
        await respond({ server, status: 'enabled' })

        return
      }

      if (action === 'authorize') {
        const flow = await completeMcpDesktopOAuth({
          serverName: server,
          profile: oauthScope,
          cancelled: () => cancelRef.current
        })

        triggerHaptic('submit')
        await respond({ server, status: 'authorized', tools: (flow.tools ?? []).map(tool => tool.name) })

        return
      }

      // Install: prefer the reviewed catalog entry when one exists; otherwise
      // fall back to the desktop suggestion directory (official URL-only
      // remotes), written through the same validated POST the dashboard's add
      // form uses. Required catalog credentials get an inline prompt first
      // (never pre-filled, never echoed back).
      let resolved = entry

      if (resolved === undefined) {
        const catalog = await getMcpCatalog()
        resolved = catalog.entries.find(candidate => candidate.name === server) ?? null
        setEntry(resolved)
      }

      if (!resolved) {
        const known = directoryEntry(server)

        if (!known) {
          await respond({ detail: copy.notInCatalog(server), server, status: 'error' })

          return
        }

        // URL-only remote: add to config, then run the OAuth/probe flow so
        // "Install" lands the user on a working server, not a 401. If the
        // flow dies after the config write (cancel, closed OAuth tab), roll
        // the write back — decline means "no server", not an unauthorized
        // entry squatting in mcp_servers (authoritative-write rule).
        await addMcpServer({ name: known.name, url: known.url }, oauthScope)

        let flow

        try {
          flow = await completeMcpDesktopOAuth({
            serverName: known.name,
            profile: oauthScope,
            cancelled: () => cancelRef.current
          })
        } catch (error) {
          await removeMcpServer(known.name, oauthScope).catch(() => {
            // Rollback is best-effort; the primary error/cancel wins.
          })
          throw error
        }

        triggerHaptic('submit')
        await respond({ server, status: 'installed', tools: (flow.tools ?? []).map(tool => tool.name) })

        return
      }

      const required = resolved.required_env.filter(env => env.required)

      if (required.some(env => !envDraft[env.name]?.trim())) {
        // Reveal the credential fields; the user approves again once filled.
        setEnvOpen(true)

        return
      }

      const res = await installMcpCatalogEntry(server, envDraft)

      // Git-backed entries clone in the background — poll to completion so a
      // non-zero exit surfaces as a real failure instead of a false success.
      if (res.background && res.action) {
        for (;;) {
          const status = throwIfCancelled(await getActionStatus(res.action, 1))

          if (!status.running) {
            if (status.exit_code !== 0) {
              throw new Error(copy.failed(server))
            }

            break
          }

          await new Promise(resolve => setTimeout(resolve, CATALOG_INSTALL_POLL_MS))
        }
      }

      triggerHaptic('submit')
      await respond({ server, status: 'installed' })
    } catch (error) {
      // User cancel: the declined respond is already on the wire — the
      // abandoned flow just stops, nothing to report.
      if (error === CANCELLED || error instanceof McpOAuthCancelled) {
        return
      }

      notifyError(error, copy.failed(server))
      await respond({
        detail: error instanceof Error ? error.message : String(error),
        server,
        status: 'error'
      })
    } finally {
      setWorking(false)
    }
  }, [action, copy, entry, envDraft, respond, server])

  const title =
    action === 'enable'
      ? copy.enableTitle(prettyName(server))
      : action === 'authorize'
        ? copy.authorizeTitle(prettyName(server))
        : copy.installTitle(prettyName(server))

  const actionLabel =
    action === 'enable' ? copy.enableAction : action === 'authorize' ? copy.authorizeAction : copy.installAction

  // What connecting actually means — the endpoint that will be contacted.
  // VS Code's trust dialog links the config it's about to trust; same idea.
  // Catalog entries carry their transport URL in the API response; the
  // static directory remains a fallback rung for older backends.
  const known = directoryEntry(server)
  const sourceLine = action === 'install' ? (entry?.url ?? known?.url ?? copy.catalogSource) : null
  const brand = brandFor(server)

  const trailingIcon = brand ? (
    <brand.Icon aria-hidden className="mt-px size-4 shrink-0" style={brandGlyphStyle(brand)} />
  ) : (
    <Codicon className={ICON_CLASS} name="plug" size="1rem" />
  )

  // ⌘/Ctrl+Enter → approve, Esc → decline/cancel. Same accelerators, same
  // guard shape as the approval bar (tool/approval.tsx). Unlike approve, Esc
  // stays live while a flow is in flight — that's the cancel path. Stands
  // down whenever a focusable control has focus (clarify's rule): a keystroke
  // meant for the composer, a popover, or the card's own credential fields
  // must never silently approve an install or throw away typed input.
  useEffect(() => {
    if (!ready) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      const active = document.activeElement as HTMLElement | null

      if (
        active &&
        (active.isContentEditable || active.matches('a[href], button, input, select, textarea, [role="button"]'))
      ) {
        return
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        if (!working) {
          event.preventDefault()
          void approve()
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        decline()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [approve, decline, ready, working])

  if (!ready) {
=======
  // `tool.start` arrives before `connection.request`.
  if (!live || !request) {
>>>>>>> f97608f178
    return (
      <div className={cn(SHELL_CLASS, 'my-1.5 flex items-center gap-2')} data-slot="connector-card">
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
        <span className="text-(--ui-text-tertiary)">{TITLE[action](copy)}</span>
      </div>
    )
  }

  return <McpSetupOffer action={action} owner={owner} request={request} />
}

interface McpSetupOfferProps {
  action: SetupAction
  /** Null until the session's owner resolves; only Try again needs it, so the rest of the card works. */
  owner: ConnectionOwner | null
  request: ConnectionRequest
}

/** The card is a projection of the operation: one row per target, one verb per row, Continue below. */
export function McpSetupOffer({ action, owner, request }: McpSetupOfferProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const [reissuing, setReissuing] = useState<ReadonlySet<string>>(new Set())
  const unresolved = request.targets.some(target => !CONNECTOR_CARD_PHASES[target.state].resolved)

  const settledRows = request.targets.map(target => ({
    name: target.name,
    state: target.state,
    tools: target.tools.length,
    toolsUnavailable: Boolean(target.discoveryError)
  }))

  // A DOM handle for the focus handoff, never rendered state.
  const cardRef = useRef<HTMLDivElement | null>(null)

  useConnectorFocusHandoff(request.targets, cardRef)

  // Try again is one RPC on the open operation. An authorize target comes back with a fresh link,
  // which opens at once; install and enable simply run again and report through connection.update.
  const reissue = async (name: string): Promise<void> => {
    if (!owner) {
      return
    }

    setReissuing(current => new Set(current).add(name))

    try {
      // The re-minted link reaches the row through connection.update; the user opens it from the row.
      await reissueConnectionTarget(owner, request, name)
    } catch (error) {
      notifyError(error, copy.failed(prettyName(name)))
    } finally {
      setReissuing(current => {
        const next = new Set(current)
        next.delete(name)

        return next
      })
    }
  }

  if (request.settled) {
    return <McpSetupSummary action={action} rows={settledRows} />
  }

  return (
    <div className="my-2 grid min-w-0 max-w-lg gap-1" data-connector-offer ref={cardRef}>
      <ConnectorCard title={TITLE[action](copy)}>
        {request.targets.map(target => (
          <McpSetupRow
            action={action}
            key={target.name}
            onReissue={() => void reissue(target.name)}
            reissueBlocked={!owner || reissuing.size > 0}
            reissuing={reissuing.has(target.name)}
            request={request}
            target={target}
          />
        ))}
      </ConnectorCard>
      {unresolved ? (
        <div className="px-3.5">
          <Button onClick={() => void continueConnectionRequest(request)} size="xs" variant="textStrong">
            {t.common.continue}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

interface McpSetupRowProps {
  action: SetupAction
  onReissue: () => void
  /** The owner has not resolved, or another row's Try again is in flight. */
  reissueBlocked: boolean
  reissuing: boolean
  request: ConnectionRequest
  target: ConnectionTarget
}

function McpSetupRow({ action, onReissue, reissueBlocked, reissuing, request, target }: McpSetupRowProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const [setupOpen, setSetupOpen] = useState(false)
  // The operation's seq when the consent was sent; null when nothing is in flight.
  const [sentAtSeq, setSentAtSeq] = useState<null | number>(null)
  const server = target.name
  const phase = CONNECTOR_CARD_PHASES[target.state]
  const verb = rowVerb(target, action)
  const fields = target.requiredEnv

  // The composer's MCP suggestion index caches the configured servers; this row just changed them.
  useEffect(() => {
    if (target.state === 'connected') {
      invalidateMcpSuggestionIndex()

      if (!target.discoveryError && target.tools.length > 0) {
        setSetupOpen(false)
      }
    } else if (target.state === 'skipped') {
      setSetupOpen(false)
    }
  }, [target.discoveryError, target.state, target.tools.length])

  // The verb stays held until the backend answers with a frame, not until the RPC returns: a second
  // click in that window would send the consent twice. The answer is any frame past the seq the
  // click saw: usually the row moves, but a partial approval (a required credential missing) leaves
  // the row where it was with a new detail, and the verb must come back for the retry. A send the
  // store refused (the operation is gone or settled under the card) sent nothing, so nothing is held.
  const sending = sentAtSeq !== null && request.seq <= sentAtSeq

  const approve = async (env?: Record<string, string>) => {
    setSentAtSeq(request.seq)

    try {
      const sent = await respondToConnectionRequest(request, {
        targets: [env ? { env, name: server, status: 'approved' } : { name: server, status: 'approved' }]
      })

      if (!sent) {
        setSentAtSeq(null)
      }
    } catch (error) {
      notifyError(error, copy.sendFailed)
      setSentAtSeq(null)
    }
  }

  const cancelSetup = async () => {
    setSetupOpen(false)

    try {
      await respondToConnectionRequest(request, { targets: [{ name: server, status: 'skipped' }] })
    } catch (error) {
      notifyError(error, copy.sendFailed)
    }
  }

  const label = VERB[action](copy)

  const ACTIONS = {
    approve: {
      busy: fields.length === 0 && sending,
      disabled: fields.length === 0 && sending,
      label,
      onClick: () => (fields.length > 0 ? setSetupOpen(true) : void approve())
    },
    open: {
      disabled: target.connectUrl === null,
      // An install reaches this step too, so the action's verb would read "Install" twice.
      label: action === 'authorize' ? label : t.connectors.openInBrowser,
      onClick: () => {
        if (target.connectUrl) {
          void window.hermesDesktop?.openExternal?.(target.connectUrl)
        }
      }
    },
    reissue: { busy: reissuing, disabled: reissueBlocked && !reissuing, label: t.connectors.retry, onClick: onReissue },
    working: { busy: true, label, onClick: () => {} }
  } satisfies Record<Exclude<McpVerb, 'none'>, ConnectorRowAction>

  const displayServer = prettyName(server)

  const rowCue = target.discoveryError
    ? t.connectors.authorizedToolsUnavailable
    : verb === 'open'
      ? t.connectors.waiting
      : undefined

  return (
    <>
      <ConnectorRow
        action={verb === 'none' ? undefined : ACTIONS[verb]}
        connector={{ name: server, title: displayServer }}
        cue={rowCue}
        mark={phase.mark}
        markLabel={MARK_LABEL[phase.mark](t.connectors)}
      />
      <SetupFormDialog
        copy={{
          cancel: t.connectors.setupCancel,
          connect: t.connectors.connect,
          openInBrowser: t.connectors.openInBrowser,
          setup: t.connectors.setup
        }}
        detail={target.detail}
        fields={fields}
        instructions={target.instructions}
        onCancel={() => void cancelSetup()}
        onConnect={env => void approve(env)}
        onOpenBrowser={() => {
          if (target.connectUrl) {
            void window.hermesDesktop?.openExternal?.(target.connectUrl)
          }
        }}
        open={setupOpen}
        pending={sending || target.state === 'initiated'}
        server={displayServer}
        status={target.state}
        url={target.connectUrl}
      />
    </>
  )
}
