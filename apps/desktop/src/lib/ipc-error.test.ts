import { describe, expect, it } from 'vitest'

import { stripIpcErrorPrefix } from './ipc-error'

describe('stripIpcErrorPrefix', () => {
  it('drops the Electron remote-method wrapper and the main-process error class', () => {
    expect(
      stripIpcErrorPrefix(
        "Error invoking remote method 'hermes:api': EvaBrokerError: No personal agent for this account — use Switch support target to open a customer agent."
      )
    ).toBe('No personal agent for this account — use Switch support target to open a customer agent.')
    expect(
      stripIpcErrorPrefix(
        "Error invoking remote method 'hermes:eva:refresh': Error: Sign in to evaOS Agent from Settings."
      )
    ).toBe('Sign in to evaOS Agent from Settings.')
  })

  it('leaves messages without the wrapper untouched, including an empty remainder', () => {
    expect(stripIpcErrorPrefix('Desktop boot failed.')).toBe('Desktop boot failed.')
    expect(stripIpcErrorPrefix("Error invoking remote method 'hermes:api': EvaBrokerError:")).toBe(
      "Error invoking remote method 'hermes:api': EvaBrokerError:"
    )
  })
})
