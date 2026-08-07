/** Minimal snapshot identity needed to attribute historical observations. */
export interface QueryAttributionSnapshot {
  queryId: string | null
  queryText: string | null
}

/** A query that is currently tracked by the project. */
export interface CurrentQuery {
  id: string
  query: string
}

export interface QueryAttribution {
  byId: Map<string, CurrentQuery>
  byText: Map<string, CurrentQuery>
}

/** Build the current-query lookup used by historical visibility readers. */
export function buildQueryAttribution(projectQueries: CurrentQuery[]): QueryAttribution {
  const byId = new Map<string, CurrentQuery>()
  const byText = new Map<string, CurrentQuery>()
  for (const q of projectQueries) {
    byId.set(q.id, q)
    byText.set(q.query, q)
  }
  return { byId, byText }
}

/** Resolve by stable id first, then by preserved snapshot text for replaced queries. */
export function resolveCurrentQuery(
  attribution: QueryAttribution,
  snap: QueryAttributionSnapshot,
): CurrentQuery | undefined {
  if (snap.queryId && attribution.byId.has(snap.queryId)) return attribution.byId.get(snap.queryId)
  if (snap.queryText && attribution.byText.has(snap.queryText)) return attribution.byText.get(snap.queryText)
  return undefined
}
