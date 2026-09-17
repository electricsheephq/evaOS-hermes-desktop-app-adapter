import { describe, expect, it } from 'vitest'

import { classifyCodexReloginText } from './codex-relogin-text'

describe('classifyCodexReloginText', () => {
  it.each([
    'agent init failed: Codex token refresh failed: Your refresh token has expired. Please sign in again.',
    'agent init failed: Codex token refresh failed with status 401.',
    'agent init failed: Codex token refresh failed with status 400.',
    'agent init failed: Codex refresh token was already consumed by another client (e.g. Codex CLI or VS Code extension). Please sign in again.',
    'agent init failed: Codex token refresh failed: invalid_grant'
  ])('maps a Codex relogin failure to the existing OAuth card: %s', text => {
    expect(classifyCodexReloginText(text)).toMatchObject({
      authKind: 'oauth',
      layer: 'auth',
      provider: 'openai-codex',
      retryable: true
    })
  })

  it.each([
    'agent init failed: Codex token refresh failed with status 503.',
    'agent init failed: Codex token refresh failed with status 429.',
    'agent init failed: Codex provider quota exhausted (429); retry after 30s. Credentials are still valid.',
    'agent init failed: xAI token refresh failed: invalid_grant'
  ])('does not offer provider sign-in for transient or non-Codex text: %s', text => {
    expect(classifyCodexReloginText(text)).toBeNull()
  })
})
