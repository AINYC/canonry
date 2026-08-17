import { GTM_COMPARISON_SCHEMA_VERSION, GTM_SNAPSHOT_SCHEMA_VERSION } from './constants.js'
import { checksumJson } from './checksum.js'
import { GtmApiError } from './types.js'
import type {
  GtmBuiltInVariable,
  GtmContainerComparison,
  GtmContainerSnapshot,
  GtmContainerVersion,
  GtmEntityChange,
  GtmEntityKind,
  GtmFolder,
  GtmRawEntity,
  GtmSnapshotEntity,
  GtmSnapshotEntitySets,
  GtmTag,
  GtmTrigger,
  GtmVariable,
  GtmWorkspace,
  GtmWorkspaceStatus,
} from './types.js'

export interface GtmWorkspaceEntityLists {
  tags: GtmTag[]
  triggers: GtmTrigger[]
  variables: GtmVariable[]
  folders: GtmFolder[]
  builtInVariables: GtmBuiltInVariable[]
}

const COMPARISON_METADATA_KEYS = new Set([
  'accountId',
  'containerId',
  'workspaceId',
  'path',
  'fingerprint',
  'tagManagerUrl',
])

function comparisonValue(raw: GtmRawEntity): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !COMPARISON_METADATA_KEYS.has(key)),
  )
}

function resourceId(kind: GtmEntityKind, raw: GtmRawEntity): string {
  const explicit = kind === 'tag'
    ? (raw as GtmTag).tagId
    : kind === 'trigger'
      ? (raw as GtmTrigger).triggerId
      : kind === 'variable'
        ? (raw as GtmVariable).variableId
        : kind === 'folder'
          ? (raw as GtmFolder).folderId
          : (raw as GtmBuiltInVariable).type
  if (explicit) return explicit

  if (raw.path) {
    const finalSegment = raw.path.split('/').filter(Boolean).at(-1)
    if (finalSegment) return finalSegment
  }
  if (raw.name) return `name:${raw.name}`
  return `anonymous:${checksumJson(raw)}`
}

function snapshotEntity<T extends GtmRawEntity>(kind: GtmEntityKind, raw: T): GtmSnapshotEntity<T> {
  return {
    kind,
    id: resourceId(kind, raw),
    name: raw.name ?? null,
    fingerprint: 'fingerprint' in raw && typeof raw.fingerprint === 'string' ? raw.fingerprint : null,
    checksum: checksumJson(raw),
    contentChecksum: checksumJson(comparisonValue(raw)),
    raw,
  }
}

function snapshotEntities(lists: GtmWorkspaceEntityLists): GtmSnapshotEntitySets {
  const entities: GtmSnapshotEntitySets = {
    tags: lists.tags.map((raw) => snapshotEntity('tag', raw)),
    triggers: lists.triggers.map((raw) => snapshotEntity('trigger', raw)),
    variables: lists.variables.map((raw) => snapshotEntity('variable', raw)),
    folders: lists.folders.map((raw) => snapshotEntity('folder', raw)),
    builtInVariables: lists.builtInVariables.map((raw) => snapshotEntity('builtInVariable', raw)),
  }

  entities.tags.sort((left, right) => left.id.localeCompare(right.id))
  entities.triggers.sort((left, right) => left.id.localeCompare(right.id))
  entities.variables.sort((left, right) => left.id.localeCompare(right.id))
  entities.folders.sort((left, right) => left.id.localeCompare(right.id))
  entities.builtInVariables.sort((left, right) => left.id.localeCompare(right.id))
  assertUniqueIdentities(entities)
  return entities
}

function allEntities(sets: GtmSnapshotEntitySets): GtmSnapshotEntity[] {
  return [
    ...sets.tags,
    ...sets.triggers,
    ...sets.variables,
    ...sets.folders,
    ...sets.builtInVariables,
  ]
}

function assertUniqueIdentities(sets: GtmSnapshotEntitySets): void {
  const seen = new Set<string>()
  for (const entity of allEntities(sets)) {
    const identity = `${entity.kind}:${entity.id}`
    if (seen.has(identity)) {
      throw new GtmApiError(`Tag Manager returned duplicate ${entity.kind} identity`, 502, {
        reason: 'DUPLICATE_ENTITY_IDENTITY',
      })
    }
    seen.add(identity)
  }
}

function snapshotChecksum(
  accountId: string | null,
  containerId: string | null,
  entities: GtmSnapshotEntitySets,
): string {
  return checksumJson({
    accountId,
    containerId,
    entities: allEntities(entities).map((entity) => ({
      kind: entity.kind,
      id: entity.id,
      contentChecksum: entity.contentChecksum,
    })),
  })
}

export function buildLiveSnapshot(version: GtmContainerVersion): GtmContainerSnapshot {
  const entities = snapshotEntities({
    tags: version.tag ?? [],
    triggers: version.trigger ?? [],
    variables: version.variable ?? [],
    folders: version.folder ?? [],
    builtInVariables: version.builtInVariable ?? [],
  })
  const accountId = version.accountId ?? null
  const containerId = version.containerId ?? null

  return {
    schemaVersion: GTM_SNAPSHOT_SCHEMA_VERSION,
    source: 'live',
    identity: {
      accountId,
      containerId,
      containerVersionId: version.containerVersionId ?? null,
      workspaceId: null,
      path: version.path ?? null,
      fingerprint: version.fingerprint ?? null,
    },
    entities,
    checksum: snapshotChecksum(accountId, containerId, entities),
    raw: { containerVersion: version },
  }
}

export function buildWorkspaceSnapshot(
  workspace: GtmWorkspace,
  status: GtmWorkspaceStatus,
  lists: GtmWorkspaceEntityLists,
): GtmContainerSnapshot {
  const entities = snapshotEntities(lists)
  const accountId = workspace.accountId ?? null
  const containerId = workspace.containerId ?? null

  return {
    schemaVersion: GTM_SNAPSHOT_SCHEMA_VERSION,
    source: 'workspace',
    identity: {
      accountId,
      containerId,
      containerVersionId: null,
      workspaceId: workspace.workspaceId ?? null,
      path: workspace.path ?? null,
      fingerprint: workspace.fingerprint ?? null,
    },
    entities,
    checksum: snapshotChecksum(accountId, containerId, entities),
    raw: { workspace, workspaceStatus: status },
  }
}

function fingerprintMatches(
  live: GtmSnapshotEntity | undefined,
  draft: GtmSnapshotEntity | undefined,
): boolean | null {
  if (!live?.fingerprint || !draft?.fingerprint) return null
  return live.fingerprint === draft.fingerprint
}

export function compareContainerSnapshots(
  live: GtmContainerSnapshot,
  draft: GtmContainerSnapshot,
): GtmContainerComparison {
  if (live.source !== 'live' || draft.source !== 'workspace') {
    throw new GtmApiError('Comparison requires one live snapshot and one workspace snapshot', 400, {
      reason: 'INVALID_SNAPSHOT_PAIR',
    })
  }
  if (
    live.identity.accountId !== draft.identity.accountId ||
    live.identity.containerId !== draft.identity.containerId
  ) {
    throw new GtmApiError('Live and workspace snapshots belong to different containers', 400, {
      reason: 'CONTAINER_IDENTITY_MISMATCH',
    })
  }

  const liveByIdentity = new Map(allEntities(live.entities).map((entity) => [`${entity.kind}:${entity.id}`, entity]))
  const draftByIdentity = new Map(allEntities(draft.entities).map((entity) => [`${entity.kind}:${entity.id}`, entity]))
  const identities = [...new Set([...liveByIdentity.keys(), ...draftByIdentity.keys()])].sort()
  const changes: GtmEntityChange[] = identities.map((identity) => {
    const liveEntity = liveByIdentity.get(identity)
    const draftEntity = draftByIdentity.get(identity)
    const contentMatches = Boolean(
      liveEntity && draftEntity && liveEntity.contentChecksum === draftEntity.contentChecksum,
    )
    const status = !liveEntity
      ? 'added'
      : !draftEntity
        ? 'removed'
        : contentMatches
          ? 'unchanged'
          : 'changed'

    const entity = draftEntity ?? liveEntity
    if (!entity) throw new Error('Entity comparison invariant failed')
    return {
      kind: entity.kind,
      id: entity.id,
      name: entity.name,
      status,
      contentMatches,
      providerFingerprintMatches: fingerprintMatches(liveEntity, draftEntity),
      live: liveEntity ?? null,
      draft: draftEntity ?? null,
    }
  })

  const workspaceStatus = draft.raw.workspaceStatus ?? {}
  const workspaceChanges = workspaceStatus.workspaceChange ?? []
  const mergeConflicts = workspaceStatus.mergeConflict ?? []
  const hasConflicts = mergeConflicts.length > 0
  const hasUnpublishedChanges = hasConflicts || workspaceChanges.length > 0 ||
    changes.some((change) => change.status !== 'unchanged')

  return {
    schemaVersion: GTM_COMPARISON_SCHEMA_VERSION,
    state: hasConflicts ? 'conflicted' : hasUnpublishedChanges ? 'unpublished-changes' : 'in-sync',
    hasUnpublishedChanges,
    hasConflicts,
    liveChecksum: live.checksum,
    draftChecksum: draft.checksum,
    changes,
    workspaceChanges,
    mergeConflicts,
  }
}
