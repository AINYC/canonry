import { and, eq, isNull } from 'drizzle-orm'
import {
  googleAdsConnections,
  googleAdsRawSnapshots,
  gtmConnections,
  gtmRawSnapshots,
  projects,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  GoogleAdsSnapshotKinds,
  RunKinds,
  RunStatuses,
  describeError,
  hostOf,
  serializeRunError,
  type GoogleAdsRawSnapshotDto,
  type GtmRawSnapshotDto,
} from '@ainyc/canonry-contracts'
import type { GoogleMarketingRuntime } from './google-marketing-runtime.js'

function safeErrorMessage(error: unknown): string {
  const raw = describeError(error)
  return raw
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/(["']?(?:developer|access|refresh|client)[_-]?(?:token|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 1_000)
}

function googleAdsSnapshotValues(snapshot: GoogleAdsRawSnapshotDto) {
  return {
    ...snapshot.metadata,
    payload: snapshot.payload,
  }
}

function gtmSnapshotValues(snapshot: GtmRawSnapshotDto) {
  return {
    ...snapshot.metadata,
    payload: snapshot.payload,
  }
}

function assertSnapshotContext(
  metadata: { projectId: string; connectionId: string; runId: string },
  expected: { projectId: string; connectionId: string; runId: string },
): void {
  if (
    metadata.projectId !== expected.projectId
    || metadata.connectionId !== expected.connectionId
    || metadata.runId !== expected.runId
  ) {
    throw new Error('Google Marketing runtime returned snapshot metadata for a different run context.')
  }
}

function requireSyncRun(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  kind: typeof RunKinds['google-ads-sync'] | typeof RunKinds['gtm-sync'],
) {
  const run = db.select().from(runs).where(and(
    eq(runs.id, runId),
    eq(runs.projectId, projectId),
    eq(runs.kind, kind),
  )).get()
  if (!run) throw new Error(`Run ${runId} is not a ${kind} run for this project.`)
  if (run.status !== RunStatuses.queued) {
    throw new Error(`Run ${runId} is ${run.status}; only queued Google Marketing runs can start.`)
  }
  return run
}

function markFailed(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  kind: typeof RunKinds['google-ads-sync'] | typeof RunKinds['gtm-sync'],
  expectedStatus: typeof RunStatuses.queued | typeof RunStatuses.running,
  error: unknown,
): void {
  db.update(runs).set({
    status: RunStatuses.failed,
    error: serializeRunError({ message: safeErrorMessage(error) }),
    finishedAt: new Date().toISOString(),
  }).where(and(
    eq(runs.id, runId),
    eq(runs.projectId, projectId),
    eq(runs.kind, kind),
    eq(runs.status, expectedStatus),
  )).run()
}

function claimSyncRun(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  kind: typeof RunKinds['google-ads-sync'] | typeof RunKinds['gtm-sync'],
  startedAt: string,
): boolean {
  const claim = db.update(runs).set({ status: RunStatuses.running, startedAt, error: null })
    .where(and(
      eq(runs.id, runId),
      eq(runs.projectId, projectId),
      eq(runs.kind, kind),
      eq(runs.status, RunStatuses.queued),
    )).run()
  return claim.changes === 1
}

/** Execute one queued, bounded Google Ads read and atomically publish its sanitized evidence. */
export async function executeGoogleAdsMarketingSync(
  db: DatabaseClient,
  runtime: GoogleMarketingRuntime,
  runId: string,
  projectId: string,
): Promise<void> {
  let claimed = false
  try {
    requireSyncRun(db, runId, projectId, RunKinds['google-ads-sync'])
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error(`Project ${projectId} was not found.`)
    const connection = db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.projectId, projectId)).get()
    if (!connection?.selectedCustomerId) {
      throw new Error('Google Ads needs a selected customer before it can sync.')
    }

    const startedAt = new Date().toISOString()
    if (!claimSyncRun(db, runId, projectId, RunKinds['google-ads-sync'], startedAt)) {
      throw new Error(`Run ${runId} could not be claimed for Google Ads sync.`)
    }
    claimed = true

    const result = await runtime.syncGoogleAds({
      project: { id: project.id, name: project.name },
      connectionId: connection.id,
      runId,
      selection: {
        customerId: connection.selectedCustomerId,
        loginCustomerId: connection.selectedLoginCustomerId,
        selectedAt: connection.lastValidatedAt,
      },
    })
    const expected = { projectId, connectionId: connection.id, runId }
    assertSnapshotContext(result.accessibleCustomers.metadata, expected)
    assertSnapshotContext(result.inventory.metadata, expected)
    if (result.metrics) assertSnapshotContext(result.metrics.metadata, expected)
    if (result.accessibleCustomers.payload.kind !== GoogleAdsSnapshotKinds['accessible-customers']) {
      throw new Error('Google Marketing runtime returned the wrong customer snapshot kind.')
    }
    if (result.inventory.payload.kind !== GoogleAdsSnapshotKinds.inventory) {
      throw new Error('Google Marketing runtime returned the wrong inventory snapshot kind.')
    }
    if (result.metrics && result.metrics.payload.kind !== GoogleAdsSnapshotKinds['campaign-metrics']) {
      throw new Error('Google Marketing runtime returned the wrong metrics snapshot kind.')
    }
    if (
      result.accessibleCustomers.metadata.customerId !== connection.selectedCustomerId
      || result.inventory.metadata.customerId !== connection.selectedCustomerId
      || result.inventory.payload.data.customerId !== connection.selectedCustomerId
      || (result.metrics && result.metrics.metadata.customerId !== connection.selectedCustomerId)
    ) {
      throw new Error('Google Ads returned evidence for a different customer.')
    }
    const observedSelection = result.accessibleCustomers.payload.data.selection
    if (
      observedSelection.customerId !== connection.selectedCustomerId
      || observedSelection.loginCustomerId !== connection.selectedLoginCustomerId
    ) {
      throw new Error('Google Ads returned evidence for a different customer selection.')
    }
    const selectedCustomer = result.accessibleCustomers.payload.data.customers.find(
      customer => customer.customerId === connection.selectedCustomerId,
    )
    if (!selectedCustomer) {
      throw new Error('Google Ads did not return the selected customer in its validated snapshot.')
    }

    const finishedAt = new Date().toISOString()
    db.transaction((tx) => {
      const terminalClaim = tx.update(runs).set({
        status: RunStatuses.completed,
        finishedAt,
        error: null,
      }).where(and(
        eq(runs.id, runId),
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['google-ads-sync']),
        eq(runs.status, RunStatuses.running),
      )).run()
      if (terminalClaim.changes !== 1) {
        throw new Error(`Run ${runId} was no longer running when Google Ads evidence was ready.`)
      }
      const connectionClaim = tx.update(googleAdsConnections).set({
        selectedCustomerName: selectedCustomer.descriptiveName,
        selectedCustomerCurrencyCode: selectedCustomer.currencyCode,
        selectedCustomerTimeZone: selectedCustomer.timeZone,
        selectedCustomerStatus: selectedCustomer.status,
        lastValidatedAt: result.accessibleCustomers.metadata.capturedAt,
        lastCustomerSnapshotId: result.accessibleCustomers.metadata.id,
        lastInventorySnapshotAt: result.inventory.metadata.capturedAt,
        lastInventorySnapshotId: result.inventory.metadata.id,
        lastMetricsSnapshotAt: result.metrics?.metadata.capturedAt ?? connection.lastMetricsSnapshotAt,
        lastMetricsSnapshotId: result.metrics?.metadata.id ?? connection.lastMetricsSnapshotId,
        updatedAt: finishedAt,
      }).where(and(
        eq(googleAdsConnections.id, connection.id),
        eq(googleAdsConnections.projectId, projectId),
        eq(googleAdsConnections.selectedCustomerId, connection.selectedCustomerId!),
        connection.selectedLoginCustomerId === null
          ? isNull(googleAdsConnections.selectedLoginCustomerId)
          : eq(googleAdsConnections.selectedLoginCustomerId, connection.selectedLoginCustomerId),
        eq(googleAdsConnections.selectionGeneration, connection.selectionGeneration),
      )).run()
      if (connectionClaim.changes !== 1) {
        throw new Error('Google Ads selection changed while its evidence was being collected.')
      }
      tx.insert(googleAdsRawSnapshots).values([
        googleAdsSnapshotValues(result.accessibleCustomers),
        googleAdsSnapshotValues(result.inventory),
        ...(result.metrics ? [googleAdsSnapshotValues(result.metrics)] : []),
      ]).run()
    })
  } catch (error) {
    markFailed(
      db,
      runId,
      projectId,
      RunKinds['google-ads-sync'],
      claimed ? RunStatuses.running : RunStatuses.queued,
      error,
    )
    throw error
  }
}

/** Execute one queued, bounded GTM read and atomically publish its sanitized configuration graph. */
export async function executeGtmMarketingSync(
  db: DatabaseClient,
  runtime: GoogleMarketingRuntime,
  runId: string,
  projectId: string,
): Promise<void> {
  let claimed = false
  try {
    requireSyncRun(db, runId, projectId, RunKinds['gtm-sync'])
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error(`Project ${projectId} was not found.`)
    const connection = db.select().from(gtmConnections)
      .where(eq(gtmConnections.projectId, projectId)).get()
    if (!connection?.selectedAccountId || !connection.selectedContainerId) {
      throw new Error('GTM needs a selected account and container before it can sync.')
    }

    const startedAt = new Date().toISOString()
    if (!claimSyncRun(db, runId, projectId, RunKinds['gtm-sync'], startedAt)) {
      throw new Error(`Run ${runId} could not be claimed for GTM sync.`)
    }
    claimed = true

    const snapshot = await runtime.syncGtm({
      project: { id: project.id, name: project.name },
      connectionId: connection.id,
      runId,
      selection: {
        accountId: connection.selectedAccountId,
        containerId: connection.selectedContainerId,
        workspaceId: connection.selectedWorkspaceId,
      },
      expectedHostname: hostOf(project.canonicalDomain) ?? project.canonicalDomain,
    })
    assertSnapshotContext(snapshot.metadata, { projectId, connectionId: connection.id, runId })
    if (snapshot.payload.kind !== 'container') {
      throw new Error('Google Marketing runtime returned the wrong GTM snapshot kind.')
    }
    const graph = snapshot.payload.data
    if (
      snapshot.metadata.accountId !== connection.selectedAccountId
      || snapshot.metadata.containerId !== connection.selectedContainerId
      || snapshot.metadata.workspaceId !== connection.selectedWorkspaceId
    ) {
      throw new Error('GTM returned evidence for a different account, container, or workspace.')
    }

    const selectedWorkspace = connection.selectedWorkspaceId
      ? graph.workspaces.find(workspace => workspace.id === connection.selectedWorkspaceId)
      : null
    const finishedAt = new Date().toISOString()
    db.transaction((tx) => {
      const terminalClaim = tx.update(runs).set({
        status: RunStatuses.completed,
        finishedAt,
        error: null,
      }).where(and(
        eq(runs.id, runId),
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['gtm-sync']),
        eq(runs.status, RunStatuses.running),
      )).run()
      if (terminalClaim.changes !== 1) {
        throw new Error(`Run ${runId} was no longer running when GTM evidence was ready.`)
      }
      const connectionClaim = tx.update(gtmConnections).set({
        selectedAccountName: graph.account.name,
        selectedContainerName: graph.container.name,
        selectedContainerPublicId: graph.container.publicId,
        selectedWorkspaceName: selectedWorkspace?.name ?? null,
        lastValidatedAt: snapshot.metadata.capturedAt,
        lastSnapshotAt: snapshot.metadata.capturedAt,
        lastSnapshotId: snapshot.metadata.id,
        updatedAt: finishedAt,
      }).where(and(
        eq(gtmConnections.id, connection.id),
        eq(gtmConnections.projectId, projectId),
        eq(gtmConnections.selectedAccountId, connection.selectedAccountId!),
        eq(gtmConnections.selectedContainerId, connection.selectedContainerId!),
        connection.selectedWorkspaceId === null
          ? isNull(gtmConnections.selectedWorkspaceId)
          : eq(gtmConnections.selectedWorkspaceId, connection.selectedWorkspaceId),
        eq(gtmConnections.selectionGeneration, connection.selectionGeneration),
      )).run()
      if (connectionClaim.changes !== 1) {
        throw new Error('GTM selection changed while its evidence was being collected.')
      }
      tx.insert(gtmRawSnapshots).values(gtmSnapshotValues(snapshot)).run()
    })
  } catch (error) {
    markFailed(
      db,
      runId,
      projectId,
      RunKinds['gtm-sync'],
      claimed ? RunStatuses.running : RunStatuses.queued,
      error,
    )
    throw error
  }
}
