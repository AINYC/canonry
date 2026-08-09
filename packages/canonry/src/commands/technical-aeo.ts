import type { SiteHealthChangeRecordDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

/** `canonry technical-aeo score <project>` — site-level scorecard. Composite → json (not jsonl). */
export async function technicalAeoScore(project: string, opts: { runId?: string; format?: string }): Promise<void> {
  const client = getClient()
  const score = await client.getTechnicalAeoScore(project, { runId: opts.runId })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(score, null, 2))
    return
  }

  if (!score.hasData) {
    console.log(
      `No technical audit yet for "${project}". Run \`canonry technical-aeo run ${project}\` to generate one.`,
    )
    return
  }

  const lines: string[] = []
  const delta = score.deltaScore == null ? '' : ` (${score.deltaScore >= 0 ? '+' : ''}${score.deltaScore} vs prev)`
  lines.push(`Technical AEO: ${score.aggregateScore}/100${delta}`)
  lines.push(
    `Audited ${score.pagesAudited} page(s) · ${score.pagesSkipped} skipped · ${score.pagesErrored} errored · sitemap ${score.sitemapUrl}`,
  )
  lines.push(`As of ${score.auditedAt}`)
  if (score.factors.length > 0) {
    lines.push('')
    lines.push(`${'Factor'.padEnd(32)}${'Wt'.padStart(4)}${'Avg'.padStart(6)}${'Status'.padStart(9)}   Pass/Part/Fail`)
    for (const f of score.factors) {
      lines.push(
        `${f.name.slice(0, 31).padEnd(32)}${String(f.weight).padStart(4)}${String(f.avgScore).padStart(6)}${f.status.padStart(9)}   ${f.pagesPassing}/${f.pagesPartial}/${f.pagesFailing}`,
      )
    }
  }
  if (score.prioritizedFixes.length > 0) {
    lines.push('')
    lines.push('Prioritized fixes:')
    score.prioritizedFixes.forEach((fix, i) => lines.push(`  ${i + 1}. ${fix}`))
  }
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo pages <project>` — per-page breakdown. Collection → supports jsonl. */
export async function technicalAeoPages(
  project: string,
  opts: { runId?: string; status?: string; sort?: string; limit?: number; format?: string },
): Promise<void> {
  const client = getClient()
  const status = opts.status === 'success' || opts.status === 'error' ? opts.status : undefined
  const res = await client.getTechnicalAeoPages(project, { runId: opts.runId, status, sort: opts.sort, limit: opts.limit })

  if (opts.format === 'jsonl') {
    emitJsonl(res.pages.map((p) => ({ project, runId: res.runId, ...p })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(res, null, 2))
    return
  }

  if (res.pages.length === 0) {
    console.log(`No audited pages for "${project}". Run \`canonry technical-aeo run ${project}\` first.`)
    return
  }
  const lines: string[] = []
  lines.push(`${res.pages.length} of ${res.total} page(s) from run ${res.runId}:\n`)
  lines.push(`${'Score'.padStart(5)}  ${'Status'.padEnd(7)}  URL`)
  for (const p of res.pages) {
    const tail = p.status === 'error' ? `  ${p.error ?? 'error'}` : ''
    lines.push(`${String(p.overallScore).padStart(5)}  ${p.status.padEnd(7)}  ${p.url}${tail}`)
  }
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo trend <project>` — aggregate score over time. Collection → supports jsonl. */
export async function technicalAeoTrend(
  project: string,
  opts: { limit?: number; format?: string },
): Promise<void> {
  const client = getClient()
  const res = await client.getTechnicalAeoTrend(project, { limit: opts.limit })

  if (opts.format === 'jsonl') {
    emitJsonl(res.points.map((p) => ({ project, ...p })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(res, null, 2))
    return
  }

  if (res.points.length === 0) {
    console.log(`No audits yet for "${project}". Run \`canonry technical-aeo run ${project}\` first.`)
    return
  }
  const lines: string[] = []
  lines.push(`${'Date'.padEnd(26)}  ${'Score'.padStart(5)}  Pages`)
  for (const p of res.points) {
    lines.push(`${p.auditedAt.padEnd(26)}  ${String(p.aggregateScore).padStart(5)}  ${p.pagesAudited}`)
  }
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo crawl <project>` — persisted crawl metadata, not a graph dump. */
export async function technicalAeoCrawl(
  project: string,
  opts: { runId?: string; format?: string },
): Promise<void> {
  const crawl = await getClient().getTechnicalAeoCrawl(project, { runId: opts.runId })
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(crawl, null, 2))
    return
  }
  if (!crawl.hasCrawlData) {
    console.log(`No persisted site crawl for "${project}". Run \`canonry technical-aeo run ${project}\` first.`)
    return
  }
  const lines = [
    `Site crawl: ${crawl.complete ? 'complete' : 'partial'} (${crawl.runStatus ?? 'unknown'})`,
    `Root: ${crawl.rootUrl ?? '-'}`,
    `Pages: ${crawl.counts.pagesFetched} fetched · ${crawl.counts.pagesDiscovered} discovered · ${crawl.counts.pagesEligible} eligible`,
    `Links: ${crawl.counts.edges} internal/external observations · ${crawl.counts.findings} findings`,
    `Dead links: ${formatDeadLinkState(crawl.deadLinks)}`,
  ]
  if (crawl.termination) lines.push(`Stopped: ${crawl.termination}`)
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo subgraph <project>` — bounded semantic crawl neighborhood. */
export async function technicalAeoSubgraph(
  project: string,
  opts: { runId?: string; nodeKey?: string; url?: string; hops?: number; maxNodes?: number; maxEdges?: number; format?: string },
): Promise<void> {
  const res = await getClient().getSiteHealthSubgraph(project, opts)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (!res.hasCrawlData) {
    console.log(`No persisted Site Health crawl for "${project}". Run \`canonry technical-aeo run ${project}\` first.`)
    return
  }
  if (res.state !== 'ready') {
    console.log(`Site Health subgraph details are unavailable for crawl ${res.runId ?? '-'}.`)
    return
  }
  const focus = res.focusUrl ?? res.focusNodeKey ?? 'crawl root'
  const totalQualifier = res.countAccuracy === 'lower-bound' ? 'at least ' : ''
  const lines = [
    `Site Health subgraph: ${focus} (${res.hops} hop${res.hops === 1 ? '' : 's'})`,
    `${res.nodes.length} of ${totalQualifier}${res.totalNodes} node(s) · ${res.edges.length} of ${totalQualifier}${res.totalEdges} edge(s)`,
    `Crawl: ${res.complete ? 'complete' : `partial (${res.termination ?? 'incomplete'})`}`,
  ]
  if (res.countAccuracy === 'lower-bound') lines.push('Count accuracy: lower bound; traversal reached a cap, so totals and omissions may be higher.')
  if (res.truncated) lines.push(`Truncated: at least ${res.omittedNodes} node(s) and ${res.omittedEdges} edge(s) omitted. Narrow or refocus the request.`)
  if (!res.complete) lines.push(`Partial crawl: ${res.termination ?? 'incomplete'}. Results describe only persisted observations.`)
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo path <project>` — directed shortest internal-link path. */
export async function technicalAeoPath(
  project: string,
  opts: { runId?: string; fromNodeKey?: string; fromUrl?: string; toNodeKey?: string; toUrl?: string; maxDepth?: number; format?: string },
): Promise<void> {
  const res = await getClient().getSiteHealthPath(project, opts)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (res.state === 'no-crawl') {
    console.log(`No persisted Site Health crawl for "${project}". Run \`canonry technical-aeo run ${project}\` first.`)
    return
  }
  if (res.state === 'details-unavailable') {
    console.log(`Site Health path details are unavailable for crawl ${res.runId ?? '-'}.`)
    return
  }
  if (res.state === 'unreachable') {
    const qualification = res.complete ? '' : ` in the partial crawl (${res.termination ?? 'incomplete'}); this is not a site-wide conclusion`
    console.log(`No directed followable path found${qualification} to ${res.to?.url ?? 'the requested destination'} within ${res.maxDepth} hop(s).`)
    return
  }
  if (res.state === 'truncated') {
    const qualification = res.complete ? '' : ` The crawl is partial (${res.termination ?? 'incomplete'}), so this is not a site-wide conclusion.`
    console.log(`Path search reached its exploration cap before resolving ${res.to?.url ?? 'the requested destination'}. Narrow the route or reduce max depth.${qualification}`)
    return
  }
  const lines = [res.nodes.map((node) => node.url).join('\n→ ')]
  if (!res.complete) lines.push('', `Partial crawl: ${res.termination ?? 'incomplete'}. This path covers only persisted observations.`)
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo changes <project>` — cursor-paged canonical scan diff. */
export async function technicalAeoChanges(
  project: string,
  opts: { fromRunId?: string; toRunId?: string; scope?: 'all' | 'pages' | 'links'; change?: 'all' | 'added' | 'removed' | 'changed'; cursor?: string; limit?: number; format?: string },
): Promise<void> {
  const res = await getClient().getSiteHealthChanges(project, opts)
  if (opts.format === 'jsonl') {
    if (res.state === 'ready') {
      const { changes, ...header } = res
      emitJsonl([{ kind: 'site-health-changes-header', ...header }])
      emitJsonl(changes.map((record) => ({ project, fromRunId: res.fromRunId, toRunId: res.toRunId, ...record })))
    } else {
      emitJsonl([{ kind: 'site-health-changes-header', ...res }])
    }
    return
  }
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (res.state === 'unavailable') {
    console.log(`Site Health changes unavailable: ${res.reason.replaceAll('-', ' ')}.`)
    return
  }
  if (res.state === 'incompatible') {
    console.log(`Site Health changes unavailable: snapshots use incompatible ${res.mismatchedVersions.join(', ')} versions.`)
    return
  }
  const lines = [
    `Site Health changes: ${res.fromRunId} → ${res.toRunId}`,
    `Filters: ${res.filters.scope} · ${res.filters.change}`,
  ]
  if (res.summaryState === 'exact' && res.summary !== null && res.total !== null) {
    lines.push(`Pages: +${res.summary.pages.added} / -${res.summary.pages.removed} / ${res.summary.pages.changed} changed`)
    lines.push(`Links: +${res.summary.links.added} / -${res.summary.links.removed} / ${res.summary.links.changed}`)
    lines.push(`${res.changes.length} of ${res.total} change(s)${res.nextCursor ? ' (more available)' : ''}`)
  } else {
    lines.push(`Summary: omitted on continuation; ${res.changes.length} returned change(s)${res.nextCursor ? ' (more available)' : ''}`)
  }
  if (res.changes.length > 0) {
    lines.push('', 'Changes:')
    for (const record of res.changes) lines.push(`  ${formatSiteHealthChangeRecord(record)}`)
  }
  if (res.nextCursor) lines.push(`Next cursor: ${res.nextCursor}`)
  console.log(lines.join('\n'))
}

function formatSiteHealthChangeRecord(record: SiteHealthChangeRecordDto): string {
  const target = record.entity === 'page'
    ? record.after?.url ?? record.before?.url ?? record.key
    : (() => {
        const edge = record.after ?? record.before
        return edge ? `${edge.sourceUrl} → ${edge.targetUrl}` : record.key
      })()
  const fields = record.changedFields.length > 0 ? ` (${record.changedFields.join(', ')})` : ''
  return `${record.entity} ${record.change}: ${target}${fields}`
}

/** `canonry technical-aeo crawl-pages <project>` — cursor-paged crawl nodes. */
export async function technicalAeoCrawlPages(
  project: string,
  opts: {
    runId?: string
    inventoryEligible?: boolean
    fetchState?: string
    indexabilityState?: string
    auditState?: string
    sort?: 'url' | 'path' | 'score-asc' | 'score-desc'
    cursor?: string
    limit?: number
    format?: string
  },
): Promise<void> {
  const res = await getClient().getTechnicalAeoCrawlPages(project, opts)
  if (opts.format === 'jsonl') {
    emitJsonl([{
      kind: 'technical-aeo-crawl-pages-header',
      project,
      runId: res.runId,
      total: res.total,
      nextCursor: res.nextCursor,
    }])
    emitJsonl(res.pages.map((page) => ({ project, runId: res.runId, ...page })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (res.pages.length === 0) {
    console.log(`No persisted crawl pages for "${project}".`)
    return
  }
  const lines = [`${res.pages.length} of ${res.total} crawl page(s)${res.nextCursor ? ' (more available)' : ''}:`, '']
  lines.push(`${'Depth'.padStart(5)}  ${'Score'.padStart(5)}  ${'Indexability'.padEnd(15)}  URL`)
  for (const page of res.pages) {
    lines.push(`${String(page.depth ?? '-').padStart(5)}  ${String(page.auditScore ?? '-').padStart(5)}  ${page.indexabilityState.slice(0, 15).padEnd(15)}  ${page.url}`)
  }
  if (res.nextCursor) lines.push(`\nNext cursor: ${res.nextCursor}`)
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo structure <project>` — exactly one site-hierarchy level. */
export async function technicalAeoStructure(
  project: string,
  opts: { runId?: string; parentPath?: string; cursor?: string; limit?: number; format?: string },
): Promise<void> {
  const res = await getClient().getTechnicalAeoStructure(project, opts)
  if (opts.format === 'jsonl') {
    emitJsonl([{
      kind: 'technical-aeo-structure-header',
      project,
      runId: res.runId,
      parentPath: res.parentPath,
      returned: res.children.length,
      nextCursor: res.nextCursor,
    }])
    emitJsonl(res.children.map((child) => ({ project, runId: res.runId, parentPath: res.parentPath, ...child })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (res.children.length === 0) {
    console.log(`No crawl structure below ${res.parentPath} for "${project}".`)
    return
  }
  const lines = [`${res.children.length} child path(s) below ${res.parentPath}${res.nextCursor ? ' (more available)' : ''}:`, '']
  for (const child of res.children) {
    lines.push(`${String(child.pageCount).padStart(5)} pages  ${String(child.inventoryEligibleCount).padStart(5)} eligible  ${child.path}`)
  }
  if (res.nextCursor) lines.push(`\nNext cursor: ${res.nextCursor}`)
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo links <project>` — bounded internal-link edge list. */
export async function technicalAeoInternalLinks(
  project: string,
  opts: { runId?: string; sourceUrl?: string; targetUrl?: string; followable?: boolean; cursor?: string; limit?: number; format?: string },
): Promise<void> {
  const res = await getClient().getTechnicalAeoInternalLinks(project, opts)
  if (opts.format === 'jsonl') {
    emitJsonl([{
      kind: 'technical-aeo-internal-links-header',
      project,
      runId: res.runId,
      total: res.total,
      nextCursor: res.nextCursor,
    }])
    emitJsonl(res.edges.map((edge) => ({ project, runId: res.runId, ...edge })))
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (res.edges.length === 0) {
    console.log(`No persisted internal links for "${project}".`)
    return
  }
  const lines = [`${res.edges.length} of ${res.total} internal link(s)${res.nextCursor ? ' (more available)' : ''}:`, '']
  for (const edge of res.edges) {
    lines.push(`${edge.followable ? 'follow' : 'nofollow'} ×${edge.occurrences}  ${edge.sourceUrl} → ${edge.targetUrl}`)
  }
  if (res.nextCursor) lines.push(`\nNext cursor: ${res.nextCursor}`)
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo links neighbors <project>` — bounded inbound/outbound edges for one page. */
export async function technicalAeoLinkNeighbors(
  project: string,
  opts: { runId?: string; nodeKey?: string; url?: string; limit?: number; format?: string },
): Promise<void> {
  const res = await getClient().getTechnicalAeoInternalLinkNeighbors(project, opts)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  const title = res.url ?? res.nodeKey ?? 'page'
  const lines = [`Internal links for ${title}:`, '', 'Inbound:']
  for (const edge of res.inbound) lines.push(`  ${edge.sourceUrl} → ${edge.targetUrl}`)
  if (res.inbound.length === 0) lines.push('  (none)')
  if (res.inboundTruncated) lines.push('  (truncated)')
  lines.push('', 'Outbound:')
  for (const edge of res.outbound) lines.push(`  ${edge.sourceUrl} → ${edge.targetUrl}`)
  if (res.outbound.length === 0) lines.push('  (none)')
  if (res.outboundTruncated) lines.push('  (truncated)')
  console.log(lines.join('\n'))
}

/** `canonry technical-aeo dead-links <project>` — opt-in check state and bounded findings. */
export async function technicalAeoDeadLinks(
  project: string,
  opts: { runId?: string; cursor?: string; limit?: number; format?: string },
): Promise<void> {
  const res = await getClient().getTechnicalAeoDeadLinks(project, opts)
  if (opts.format === 'jsonl') {
    if ('deadLinks' in res) {
      const { deadLinks, ...header } = res
      emitJsonl([{ kind: 'technical-aeo-dead-links-header', ...header }])
      emitJsonl(deadLinks.map((finding) => ({ project, runId: res.runId, state: res.state, ...finding })))
    } else {
      emitJsonl([{ kind: 'technical-aeo-dead-links-header', ...res }])
    }
    return
  }
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  if (res.state === 'disabled') {
    console.log(`Dead-link checks were disabled for crawl ${res.runId}. Re-run with \`--check-dead-links\` to enable them.`)
    return
  }
  if (res.state === 'unavailable') {
    console.log(`No dead-link check is available for "${project}".`)
    return
  }
  const lines = [`Dead links: ${res.found} found from ${res.checked} checked (${res.state})`]
  for (const finding of res.deadLinks) lines.push(`${finding.sourceUrl ?? '-'} → ${finding.targetUrl ?? '-'}`)
  if (res.nextCursor) lines.push(`Next cursor: ${res.nextCursor}`)
  console.log(lines.join('\n'))
}

function formatDeadLinkState(value: { state: string; checked?: number; found?: number }): string {
  if (value.state === 'disabled') return 'disabled (opt in with --check-dead-links)'
  if (value.state === 'unavailable') return 'unavailable'
  return `${value.found ?? 0} found / ${value.checked ?? 0} checked (${value.state})`
}

/** `canonry technical-aeo run <project>` — trigger a site-audit run. Mutation → json (not jsonl). */
export async function technicalAeoRun(
  project: string,
  opts: { sitemapUrl?: string; limit?: number; maxPages?: number; maxEdges?: number; maxDepth?: number; checkDeadLinks?: boolean; wait?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const { runId, status } = await client.triggerSiteAudit(project, {
    sitemapUrl: opts.sitemapUrl,
    limit: opts.limit,
    maxPages: opts.maxPages,
    maxEdges: opts.maxEdges,
    maxDepth: opts.maxDepth,
    // Explicit opt-in: absence and false are both intentionally disabled.
    checkDeadLinks: opts.checkDeadLinks === true,
  })

  if (!opts.wait) {
    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify({ runId, status }, null, 2))
      return
    }
    console.log(
      `Site audit started (run ${runId}, status ${status}). Use \`canonry runs get ${runId}\` to check status, or pass --wait.`,
    )
    return
  }

  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled'])
  const start = Date.now()
  const timeoutMs = 15 * 60 * 1000
  if (!isMachineFormat(opts.format)) process.stderr.write('Auditing')
  let final = status
  while (!terminal.has(final) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const run = await client.getRun(runId)
    if (!isMachineFormat(opts.format)) process.stderr.write('.')
    final = run.status
  }
  if (!isMachineFormat(opts.format)) process.stderr.write('\n')

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({ runId, status: final }, null, 2))
    return
  }
  console.log(`Site audit ${final} (run ${runId}).`)
}
