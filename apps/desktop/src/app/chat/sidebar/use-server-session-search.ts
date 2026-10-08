import { useEffect, useState } from 'react'

import { searchSessions, type SessionSearchResult } from '@/hermes'

const NO_MATCHES: SessionSearchResult[] = []

// Full-text search across *all* sessions (not just the loaded page), debounced.
// Hits are keyed by (scope, query): a scope switch re-runs the search and fences
// the previous scope's in-flight or cached hits, so one agent's results never
// show under another (#347).
export function useServerSessionSearch(
  query: string,
  scope: string
): { pending: boolean; serverMatches: SessionSearchResult[] } {
  const key = `${scope}\n${query}`
  const [hits, setHits] = useState<{ key: string; results: SessionSearchResult[] }>({ key: '', results: [] })
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!query) {
      setHits({ key: '', results: [] })
      setPending(false)

      return
    }

    let cancelled = false

    setPending(true)

    const id = window.setTimeout(() => {
      void searchSessions(query)
        .then(res => {
          if (!cancelled) {
            setHits({ key, results: res.results })
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) {
            setPending(false)
          }
        })
    }, 200)

    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [key, query])

  return { pending, serverMatches: hits.key === key ? hits.results : NO_MATCHES }
}
