import type { ErrorSurface } from './error-surface'

/** Recover the existing OAuth re-login card for older gateways that only
 *  report a Codex refresh failure as text. Transient HTTP failures stay on the
 *  generic retry path; offering sign-in for those would be a false diagnosis. */
export function classifyCodexReloginText(text: string): ErrorSurface | null {
  if (!/\bcodex\b/i.test(text)) {
    return null
  }

  if (/\bwith status (?:429|5\d\d)\b/i.test(text) || /\bquota exhausted\b/i.test(text)) {
    return null
  }

  const reloginRequired =
    /\bCodex token refresh failed\b/i.test(text) ||
    /\bCodex refresh token was already consumed\b/i.test(text) ||
    /\binvalid_grant\b/i.test(text)

  return reloginRequired
    ? {
        layer: 'auth',
        code: 'relogin_required',
        retryable: true,
        authKind: 'oauth',
        provider: 'openai-codex',
        providerLabel: 'ChatGPT'
      }
    : null
}
