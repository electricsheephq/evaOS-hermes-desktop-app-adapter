import { describe, expect, it } from 'vitest'

import { classifyCodexReloginText, formatErrorDiagnostics, parseErrorSurface } from './error-surface'

describe('parseErrorSurface', () => {
  it('accepts a valid descriptor', () => {
    expect(parseErrorSurface({ layer: 'streaming', code: 'stream_drop', retryable: true })).toEqual({
      layer: 'streaming',
      code: 'stream_drop',
      retryable: true
    })
  })

  it('accepts every documented layer', () => {
    for (const layer of ['provider', 'endpoint', 'streaming', 'auth', 'billing', 'gateway', 'runtime', 'disk']) {
      expect(parseErrorSurface({ layer, code: 'x', retryable: false })?.layer).toBe(layer)
    }
  })

  it('rejects unknown layers and non-objects', () => {
    expect(parseErrorSurface({ layer: 'blockchain', code: 'x', retryable: true })).toBeNull()
    expect(parseErrorSurface('provider')).toBeNull()
    expect(parseErrorSurface(null)).toBeNull()
    expect(parseErrorSurface(undefined)).toBeNull()
    expect(parseErrorSurface(7)).toBeNull()
  })

  it('defaults code and retryable when missing', () => {
    expect(parseErrorSurface({ layer: 'gateway' })).toEqual({ layer: 'gateway', code: 'unknown', retryable: true })
  })

  it('honors retryable=false', () => {
    expect(parseErrorSurface({ layer: 'auth', code: 'auth_permanent', retryable: false })?.retryable).toBe(false)
  })

  it('carries the failing session identity when present', () => {
    const surface = parseErrorSurface({
      layer: 'provider',
      code: 'rate_limit',
      retryable: true,
      provider: 'openrouter',
      model: 'test/m1'
    })

    expect(surface?.provider).toBe('openrouter')
    expect(surface?.model).toBe('test/m1')
    // Absent identity yields no keys, not empty strings.
    expect(parseErrorSurface({ layer: 'provider', code: 'x', retryable: true })?.provider).toBeUndefined()
  })
})

describe('classifyCodexReloginText', () => {
  it.each([
    'agent init failed: Codex token refresh failed: invalid_grant',
    'Codex token refresh failed with status 401.',
    'Codex refresh token was already consumed'
  ])('maps a Codex relogin failure to the existing OAuth card: %s', text => {
    expect(classifyCodexReloginText(text)).toMatchObject({
      authKind: 'oauth',
      layer: 'auth',
      provider: 'openai-codex',
      retryable: true
    })
  })

  it.each([
    'Codex token refresh failed with status 503.',
    'Codex token refresh failed with status 500.',
    'Codex token refresh failed with status 429.',
    'xAI token refresh failed: invalid_grant'
  ])('does not offer provider sign-in for transient or non-Codex text: %s', text => {
    expect(classifyCodexReloginText(text)).toBeNull()
  })
})

describe('formatErrorDiagnostics', () => {
  it('includes layer, code, model and error', () => {
    const text = formatErrorDiagnostics({
      errorText: 'boom',
      model: 'anthropic/claude-opus-4.6',
      surface: { layer: 'provider', code: 'rate_limit', retryable: true }
    })

    expect(text).toContain('layer: provider')
    expect(text).toContain('code: rate_limit')
    expect(text).toContain('model: anthropic/claude-opus-4.6')
    expect(text).toContain('error: boom')
  })

  it('prefers the descriptor identity over the caller fallback', () => {
    const text = formatErrorDiagnostics({
      errorText: 'boom',
      // Foreground composer atom — potentially stale by click time.
      model: 'some/other-model',
      surface: { layer: 'provider', code: 'rate_limit', retryable: true, provider: 'openrouter', model: 'failed/model' }
    })

    expect(text).toContain('provider: openrouter')
    expect(text).toContain('model: failed/model')
    expect(text).not.toContain('some/other-model')
  })

  it('omits absent fields without leaving blank lines', () => {
    const text = formatErrorDiagnostics({ errorText: 'boom' })

    expect(text).not.toContain('layer:')
    expect(text).not.toContain('model:')
    expect(text.split('\n').every(line => line.trim().length > 0)).toBe(true)
  })
})
