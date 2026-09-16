async function requestAuthorizedCronJobs({
  runtime,
  request,
  retry,
  requestApi,
  profileMismatchError,
  supportProfileError
}) {
  const parsed = new URL(String(request.path), 'http://eva-managed.invalid')
  const jobs = []

  for (const profile of runtime.allowedProfiles) {
    parsed.searchParams.set('profile', profile)
    const result = await requestApi(
      { ...request, profile, path: `${parsed.pathname}?${parsed.searchParams}` },
      retry
    )
    for (const row of result ?? []) {
      if (row.profile != null && row.profile !== profile) {
        throw runtime.sessionKind === 'delegated_support'
          ? supportProfileError()
          : profileMismatchError(row.profile)
      }
      jobs.push({ ...row, profile })
    }
  }

  return jobs
}

module.exports = { requestAuthorizedCronJobs }
