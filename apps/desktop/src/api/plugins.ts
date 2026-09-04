import { type GatewayWsUrlResult, resolveGatewayWsUrl } from '@hermes/shared'

import type { HermesConnection } from '@/global'
import { reconnectBackoffDelayMs } from '@/lib/reconnect-backoff'
import { RECONNECT_ATTEMPT_TIMEOUT_MS, withTimeout } from '@/lib/with-timeout'

import {
  getApiRequestConnection,
  getApiRequestProfile,
  hermesApi,
  profileScoped,
  subscribeApiRequestProfile
} from './client'

/** Resolve the ACTIVE backend's connection descriptor, (connectionId,
 *  profile)-scoped — mirroring how store/profile resolves $connection: a
 *  registry agent's descriptor comes from getConnectionFor (its SOURCE
 *  connection), everything else from the profile-keyed local pool. The
 *  getConnectionFor bridge is optional (older Desktop mains); without it the
 *  profile-scoped pool lookup is the best available answer.
 *
 *  Both branches are IPC round-trips into the main process with no timeout of
 *  their own (#93454) — a wedged main-process round-trip otherwise hangs
 *  pluginSocket's connect() forever instead of falling back to the polling
 *  fallback every consumer already has. Bound the same way store/gateway's
 *  openSecondary bounds the same *For/plain pair.
 *
 *  Exported for tests. */
export async function activeConnection(): Promise<HermesConnection> {
  const getConnectionFor = window.hermesDesktop.getConnectionFor
  const connectionId = getApiRequestConnection()
  const profile = getApiRequestProfile()

  if (connectionId && getConnectionFor) {
    return withTimeout(
      getConnectionFor({ connectionId, profile }),
      RECONNECT_ATTEMPT_TIMEOUT_MS,
      `Timed out connecting to profile "${profile}"`
    )
  }

  return withTimeout(
    window.hermesDesktop.getConnection(profile),
    RECONNECT_ATTEMPT_TIMEOUT_MS,
    `Timed out connecting to profile "${profile}"`
  )
}

/** Options for a plugin REST call — mirrors the app's own `hermesDesktop.api`
 *  shape, minus the path (which is namespace-derived). */
export interface PluginRestOptions {
  method?: string
  body?: unknown
  /** Single-file multipart upload (see HermesApiRequest.upload). */
  upload?: { filename: string; contentType?: string; bytes: ArrayBuffer }
  timeoutMs?: number
}

// Normalize `path` to a leading-slash suffix relative to `/api/plugins/<id>`.
// The namespace is the boundary — reject `..` so a relative segment can't
// normalize out into another plugin's API or a core route. Check the path
// portion only (before any query/hash).
function pluginPathSuffix(caller: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`

  if (suffix.split(/[?#]/, 1)[0].split('/').includes('..')) {
    throw new Error(`${caller}: illegal path traversal in "${path}"`)
  }

  return suffix
}

/** The plugin REST door. Every call is scoped BY CONSTRUCTION to the plugin's
 *  own backend namespace — `path` is relative to `/api/plugins/<pluginId>`
 *  ('/board' → `/api/plugins/kanban/board`), so a plugin can't address another
 *  plugin's API or a core route through it. Profile-aware like every desktop
 *  REST call. Broader reach (core endpoints, another namespace) is the future
 *  declared-capability seam; today the namespace IS the boundary. */
export async function pluginRest<T>(pluginId: string, path: string, opts: PluginRestOptions = {}): Promise<T> {
  if (!window.hermesDesktop?.api) {
    throw new Error('Hermes desktop bridge unavailable')
  }

  const suffix = pluginPathSuffix('pluginRest', path)

  return hermesApi<T>({
    path: `/api/plugins/${pluginId}${suffix}`,
    method: opts.method,
    body: opts.body,
    upload: opts.upload,
    timeoutMs: opts.timeoutMs,
    ...profileScoped()
  })
}

/** The plugin WebSocket door — the live twin of `pluginRest`, scoped the same
 *  way: `path` is relative to `/api/plugins/<pluginId>` ('/events' → the
 *  plugin's own event stream). Token-mode backends auth via the same query
 *  credential the app's own sockets use; OAuth remotes resolve null (callers
 *  keep their polling fallback — every consumer must have one anyway, since a
 *  socket can drop). Auto-reconnects with backoff until disposed. */
export function pluginSocket(pluginId: string, path: string, onMessage: (data: unknown) => void): () => void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId)) {
    throw new Error(`pluginSocket: invalid plugin id "${pluginId}"`)
  }

  const suffix = pluginPathSuffix('pluginSocket', path)
  const endpointPath = `/api/plugins/${pluginId}${suffix}`

  let socket: null | WebSocket = null
  let reconnectTimer: null | number = null
  let disposed = false
  let attempt = 0
  let generation = 0

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const scheduleReconnect = (immediate = false) => {
    if (disposed || reconnectTimer !== null) {
      return
    }

    const delay = immediate
      ? 0
      : reconnectBackoffDelayMs(attempt, {
          baseDelayMs: 500,
          capMs: 30_000
        })

    if (!immediate) {
      attempt += 1
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    const connectingGeneration = generation
    const desktop = window.hermesDesktop
    const profile = getApiRequestProfile()
    const connection = await activeConnection().catch(() => null)

    if (disposed || connectingGeneration !== generation) {
      return
    }

    if (!desktop || !connection) {
      scheduleReconnect()

      return
    }

    // Managed tickets are single-use and bound to this exact plugin endpoint;
    // unmanaged connections share the canonical URL/ticket resolver.
    let wsUrl: null | string = null

    if (connection.baseUrl.startsWith('eva-managed://')) {
      const result: GatewayWsUrlResult | string | null = await desktop
        .getGatewayWsUrl(profile, endpointPath)
        .catch(() => null)

      wsUrl = typeof result === 'string' ? result : result?.ok ? result.wsUrl : null
    } else {
      wsUrl = await resolveGatewayWsUrl(desktop, connection, endpointPath).catch(() => null)
    }

    if (disposed || connectingGeneration !== generation) {
      return
    }

    if (!wsUrl) {
      scheduleReconnect()

      return
    }

    const nextSocket = new WebSocket(wsUrl)
    socket = nextSocket

    nextSocket.onopen = () => {
      if (socket === nextSocket) {
        attempt = 0
      }
    }

    nextSocket.onmessage = event => {
      try {
        onMessage(JSON.parse(String(event.data)))
      } catch {
        // Non-JSON frame — plugin streams are JSON by contract; skip it.
      }
    }

    nextSocket.onclose = () => {
      if (socket !== nextSocket) {
        return
      }

      socket = null
      scheduleReconnect()
    }
  }

  const unsubscribeProfile = subscribeApiRequestProfile(() => {
    generation += 1
    attempt = 0
    clearReconnectTimer()
    const previous = socket
    socket = null
    previous?.close()
    scheduleReconnect(true)
  })

  void connect()

  return () => {
    disposed = true
    generation += 1
    unsubscribeProfile()
    clearReconnectTimer()
    const previous = socket
    socket = null
    previous?.close()
  }
}
