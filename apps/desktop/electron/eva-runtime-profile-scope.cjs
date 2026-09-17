async function requestAuthorizedCronJobs({
  runtime,
  request,
  retry,
  requestApi,
  cache,
  leafFailureKind,
  profileMismatchError,
  supportProfileError,
  assertOrdinaryScopeUnchanged,
  startSupportRequestGuard,
  assertSupportRequestCurrent,
  finishSupportRequestGuard
}) {
  const parsed = new URL(String(request.path), 'http://eva-managed.invalid')
  const jobs = []
  const errors = []
  const guard = startSupportRequestGuard(runtime)

  try {
    for (const profile of runtime.allowedProfiles) {
      assertSupportRequestCurrent(guard)
      parsed.searchParams.set('profile', profile)
      let result
      try {
        result = await requestApi(
          { ...request, profile, path: `${parsed.pathname}?${parsed.searchParams}` },
          retry
        )
      } catch (error) {
        assertSupportRequestCurrent(guard)
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : null
        const kind = leafFailureKind(runtime, error)
        if (kind === null) throw error
        if (kind === 'refused') cache.delete(profile)
        errors.push({ profile, error: 'Profile temporarily unavailable.', ...(status === null ? {} : { status }),
          ...(kind === 'refused' ? { code: 'support-profile-refused' } : {}) })
        if (kind !== 'refused') jobs.push(...structuredClone(cache.get(profile) ?? []))
        continue
      }
      assertSupportRequestCurrent(guard)
      const fresh = []
      for (const row of result ?? []) {
        if (row.profile != null && row.profile !== profile) {
          throw runtime.sessionKind === 'delegated_support'
            ? supportProfileError()
            : profileMismatchError(row.profile)
        }
        fresh.push({ ...row, profile })
      }
      cache.set(profile, structuredClone(fresh))
      jobs.push(...fresh)
    }
  } finally {
    finishSupportRequestGuard(guard)
  }

  assertOrdinaryScopeUnchanged(runtime)
  return errors.length ? { errors, jobs } : jobs
}

module.exports = { requestAuthorizedCronJobs }
