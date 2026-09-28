/**
 * Sibling WebSocket URLs beside `/api/ws` for a (connection, profile) route.
 *
 * Some gateway streams are not JSON-RPC and cannot share the gateway socket:
 * voice PCM (`/api/audio/speak-stream`) and the Bot Screen's raw RFB
 * (`/api/display/ws`). They ride the SAME authenticated origin the route's
 * `/api/ws` uses — a fresh credential for OAuth remotes, the registry-scoped
 * `*For` bridges for a remote riding over a local install (the bare
 * getConnection/getGatewayWsUrl pair answers for the v1 primary backend, which
 * would be the wrong machine). One resolver so every sibling stream routes the
 * way chat does.
 */

import { resolveGatewayWsUrl } from '@hermes/shared'

const RESOLVE_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export interface SiblingWsRoute {
  connectionId?: null | string
  profile?: null | string
}

/**
 * Resolve `ws(s)://<gateway>/<path>` for `route`. `stripGatewayCredential`
 * drops the `?ticket=`/`?token=` the gateway URL carried when the sibling route
 * authenticates on its own credential (a one-shot ticket must not be spent
 * twice; the display bridge mints its own). `query` is appended to the
 * sibling endpoint.
 */
export async function resolveSiblingWsUrl(
  route: SiblingWsRoute,
  path: string,
  options: { query?: Record<string, string>; stripGatewayCredential?: boolean } = {}
): Promise<string> {
  const desktop = window.hermesDesktop

  if (!desktop?.getConnection) {
    throw new Error('Hermes Desktop connection bridge unavailable')
  }

  const connectionId = route.connectionId?.trim() || null
  const profile = route.profile?.trim() || null

  const conn =
    connectionId && desktop.getConnectionFor
      ? await withTimeout(
          desktop.getConnectionFor({ connectionId, profile }),
          RESOLVE_TIMEOUT_MS,
          `Timed out connecting to profile "${profile}"`
        )
      : await withTimeout(
          desktop.getConnection(profile),
          RESOLVE_TIMEOUT_MS,
          `Timed out connecting to profile "${profile}"`
        )

  const endpointPath = path.startsWith('/') ? path : `/${path}`
  const query = new URLSearchParams(options.query)
  const search = query.toString()

  // Managed relay tickets bind one exact endpoint, query included, so mint for
  // the sibling endpoint itself rather than rewriting the /api/ws ticket's URL.
  if (conn.baseUrl?.startsWith('eva-managed://')) {
    const managedUrl = new URL(
      await withTimeout(
        resolveGatewayWsUrl(desktop, conn, search ? `${endpointPath}?${search}` : endpointPath),
        RESOLVE_TIMEOUT_MS,
        'Timed out minting the gateway WebSocket URL'
      )
    )

    if (managedUrl.pathname !== endpointPath) {
      throw new Error(`Unexpected gateway WebSocket path: ${managedUrl.pathname}`)
    }

    return managedUrl.toString()
  }

  const wsDeps =
    connectionId && desktop.getGatewayWsUrlFor
      ? { getGatewayWsUrl: () => desktop.getGatewayWsUrlFor!({ connectionId, profile }) }
      : connectionId
        ? {}
        : desktop

  const wsUrl = await withTimeout(
    resolveGatewayWsUrl(wsDeps, conn),
    RESOLVE_TIMEOUT_MS,
    'Timed out minting the gateway WebSocket URL'
  )

  const url = new URL(wsUrl)

  if (!url.pathname.endsWith('/api/ws')) {
    throw new Error(`Unexpected gateway WebSocket path: ${url.pathname}`)
  }

  url.pathname = url.pathname.replace(/\/api\/ws$/, endpointPath)

  if (options.stripGatewayCredential) {
    url.searchParams.delete('ticket')
    url.searchParams.delete('token')
  }

  for (const [key, value] of query) {
    url.searchParams.set(key, value)
  }

  return url.toString()
}
