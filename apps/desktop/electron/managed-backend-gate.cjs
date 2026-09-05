'use strict'

function createManagedBackendGate({ enabled, resolveBackend }) {
  return {
    resolve(profile, fallback) {
      if (enabled) {
        return resolveBackend({ profile })
      }

      return fallback()
    },

    start(managedStart, fallback) {
      if (enabled) {
        return managedStart()
      }

      return fallback()
    }
  }
}

module.exports = { createManagedBackendGate }
