import { describe, expect, it } from 'vitest'

import { classifyManagedDeepLink } from './managed-deep-link'

const SCHEME = 'evaos-agent'

describe('managed deep links', () => {
  it('preserves blueprints while keeping auth callbacks main-process-only', () => {
    expect(
      classifyManagedDeepLink('evaos-agent://blueprint/morning-brief?time=08%3A00&topic=company+news', SCHEME)
    ).toEqual({
      type: 'blueprint',
      payload: {
        kind: 'blueprint',
        name: 'morning-brief',
        params: { time: '08:00', topic: 'company news' }
      }
    })

    const auth = classifyManagedDeepLink(
      `evaos-agent://auth/callback?device_code=${'A'.repeat(8)}&desktop_auth_state=state-12345678`,
      SCHEME
    )

    expect(auth).toEqual({ type: 'auth-callback' })
    expect(JSON.stringify(auth)).not.toMatch(/device_code|desktop_auth_state|state-12345678/)
  })

  it('rejects session and auth material instead of forwarding it', () => {
    for (const key of ['desktop_auth_state', 'device_code', 'desktop_session', 'session_token', 'token']) {
      expect(
        classifyManagedDeepLink(`evaos-agent://blueprint/morning-brief?time=08%3A00&${key}=secret`, SCHEME)
      ).toEqual({ type: 'unsupported' })
    }

    expect(classifyManagedDeepLink('evaos-agent://blueprint/morning-brief?time=08%0A00', SCHEME)).toEqual({
      type: 'unsupported'
    })
    expect(classifyManagedDeepLink('evaos-agent://other/morning-brief?time=08%3A00', SCHEME)).toEqual({
      type: 'unsupported'
    })
  })

  it('strictly accepts only an opaque support request id', () => {
    expect(classifyManagedDeepLink('evaos-agent://support/request-123', SCHEME)).toEqual({
      type: 'support',
      requestId: 'request-123'
    })

    for (const url of [
      'evaos-agent://support/request-123?profile=main',
      'evaos-agent://support/request-123/extra',
      'evaos-agent://support/request-123/',
      'evaos-agent://support/request%2F123',
      'evaos-agent://support/../request-123',
      'evaos-agent://support/request%0A123',
      'evaos-agent://support/request-123#customer'
    ]) {
      expect(classifyManagedDeepLink(url, SCHEME), url).toEqual({ type: 'unsupported' })
    }
  })
})
