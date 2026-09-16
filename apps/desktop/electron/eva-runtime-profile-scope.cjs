async function requestAuthorizedCronJobs({
  runtime,
  request,
  retry,
  requestApi,
  profileMismatchError,
  supportProfileError,
  statusCodeOf,
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
        const status = statusCodeOf(error)
        if (status !== null && status < 500) throw error
        errors.push({ profile, error: 'Profile temporarily unavailable.' })
        continue
      }
      assertSupportRequestCurrent(guard)
      for (const row of result ?? []) {
        if (row.profile != null && row.profile !== profile) {
          throw runtime.sessionKind === 'delegated_support'
            ? supportProfileError()
            : profileMismatchError(row.profile)
        }
        jobs.push({ ...row, profile })
      }
    }
  } finally {
    finishSupportRequestGuard(guard)
  }

  if (errors.length) jobs.errors = errors
  return jobs
}

module.exports = { requestAuthorizedCronJobs }
