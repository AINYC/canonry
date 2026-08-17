import type {
  GTM_COMPARISON_SCHEMA_VERSION,
  GTM_GOOGLE_ADS_CONVERSION_ASSESSMENT_SCHEMA_VERSION,
  GTM_GOOGLE_ADS_CONVERSION_RECOGNIZER_VERSION,
  GTM_SNAPSHOT_SCHEMA_VERSION,
} from './constants.js'

/** Raw recursive parameter graph returned by the Tag Manager API. */
export interface GtmParameter {
  key?: string
  type?: string
  value?: string
  list?: GtmParameter[]
  map?: GtmParameter[]
  isWeakReference?: boolean
}

export interface GtmCondition {
  type?: string
  parameter?: GtmParameter[]
}

export interface GtmAccount {
  accountId?: string
  path?: string
  name?: string
  fingerprint?: string
  tagManagerUrl?: string
  [key: string]: unknown
}

export interface GtmContainer {
  accountId?: string
  containerId?: string
  path?: string
  name?: string
  publicId?: string
  domainName?: string[]
  usageContext?: string[]
  fingerprint?: string
  tagManagerUrl?: string
  [key: string]: unknown
}

export interface GtmWorkspace {
  accountId?: string
  containerId?: string
  workspaceId?: string
  path?: string
  name?: string
  description?: string
  fingerprint?: string
  tagManagerUrl?: string
  [key: string]: unknown
}

export interface GtmTag {
  accountId?: string
  containerId?: string
  workspaceId?: string
  tagId?: string
  path?: string
  name?: string
  type?: string
  parameter?: GtmParameter[]
  firingTriggerId?: string[]
  blockingTriggerId?: string[]
  parentFolderId?: string
  paused?: boolean
  fingerprint?: string
  tagManagerUrl?: string
  [key: string]: unknown
}

export interface GtmTrigger {
  accountId?: string
  containerId?: string
  workspaceId?: string
  triggerId?: string
  path?: string
  name?: string
  type?: string
  parameter?: GtmParameter[]
  customEventFilter?: GtmCondition[]
  filter?: GtmCondition[]
  autoEventFilter?: GtmCondition[]
  parentFolderId?: string
  fingerprint?: string
  tagManagerUrl?: string
  [key: string]: unknown
}

export interface GtmVariable {
  accountId?: string
  containerId?: string
  workspaceId?: string
  variableId?: string
  path?: string
  name?: string
  type?: string
  parameter?: GtmParameter[]
  parentFolderId?: string
  fingerprint?: string
  tagManagerUrl?: string
  [key: string]: unknown
}

export interface GtmFolder {
  accountId?: string
  containerId?: string
  workspaceId?: string
  folderId?: string
  path?: string
  name?: string
  fingerprint?: string
  tagManagerUrl?: string
  [key: string]: unknown
}

export interface GtmBuiltInVariable {
  accountId?: string
  containerId?: string
  workspaceId?: string
  path?: string
  name?: string
  type?: string
  [key: string]: unknown
}

export interface GtmWorkspaceEntity {
  changeStatus?: string
  tag?: GtmTag
  trigger?: GtmTrigger
  variable?: GtmVariable
  folder?: GtmFolder
  builtInVariable?: GtmBuiltInVariable
  [key: string]: unknown
}

export interface GtmMergeConflict {
  entityInBaseVersion?: GtmWorkspaceEntity
  entityInWorkspace?: GtmWorkspaceEntity
  [key: string]: unknown
}

export interface GtmWorkspaceStatus {
  workspaceChange?: GtmWorkspaceEntity[]
  mergeConflict?: GtmMergeConflict[]
  [key: string]: unknown
}

export interface GtmContainerVersion {
  accountId?: string
  containerId?: string
  containerVersionId?: string
  path?: string
  name?: string
  description?: string
  fingerprint?: string
  deleted?: boolean
  tag?: GtmTag[]
  trigger?: GtmTrigger[]
  variable?: GtmVariable[]
  folder?: GtmFolder[]
  builtInVariable?: GtmBuiltInVariable[]
  [key: string]: unknown
}

export type GtmEntityKind = 'tag' | 'trigger' | 'variable' | 'folder' | 'builtInVariable'
export type GtmRawEntity = GtmTag | GtmTrigger | GtmVariable | GtmFolder | GtmBuiltInVariable

export interface GtmSnapshotEntity<T extends GtmRawEntity = GtmRawEntity> {
  kind: GtmEntityKind
  id: string
  name: string | null
  fingerprint: string | null
  /** Hash of the complete provider object, including the nested Parameter graph. */
  checksum: string
  /** Hash excluding provider location/version metadata, used for live/draft comparison. */
  contentChecksum: string
  raw: T
}

export interface GtmSnapshotEntitySets {
  tags: Array<GtmSnapshotEntity<GtmTag>>
  triggers: Array<GtmSnapshotEntity<GtmTrigger>>
  variables: Array<GtmSnapshotEntity<GtmVariable>>
  folders: Array<GtmSnapshotEntity<GtmFolder>>
  builtInVariables: Array<GtmSnapshotEntity<GtmBuiltInVariable>>
}

export interface GtmContainerSnapshot {
  schemaVersion: typeof GTM_SNAPSHOT_SCHEMA_VERSION
  source: 'live' | 'workspace'
  identity: {
    accountId: string | null
    containerId: string | null
    containerVersionId: string | null
    workspaceId: string | null
    path: string | null
    fingerprint: string | null
  }
  entities: GtmSnapshotEntitySets
  checksum: string
  raw: {
    containerVersion?: GtmContainerVersion
    workspace?: GtmWorkspace
    workspaceStatus?: GtmWorkspaceStatus
  }
}

export type GtmEntityChangeStatus = 'added' | 'removed' | 'changed' | 'unchanged'

export interface GtmEntityChange {
  kind: GtmEntityKind
  id: string
  name: string | null
  status: GtmEntityChangeStatus
  contentMatches: boolean
  providerFingerprintMatches: boolean | null
  live: GtmSnapshotEntity | null
  draft: GtmSnapshotEntity | null
}

export interface GtmContainerComparison {
  schemaVersion: typeof GTM_COMPARISON_SCHEMA_VERSION
  state: 'in-sync' | 'unpublished-changes' | 'conflicted'
  hasUnpublishedChanges: boolean
  hasConflicts: boolean
  liveChecksum: string
  draftChecksum: string
  changes: GtmEntityChange[]
  workspaceChanges: GtmWorkspaceEntity[]
  mergeConflicts: GtmMergeConflict[]
}

export interface GtmRetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface GtmClientOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  retry?: GtmRetryOptions
}

export class GtmApiError extends Error {
  public readonly status: number
  public readonly providerStatus: string | null
  public readonly reason: string | null
  public readonly retryAfter: string | null
  public readonly requestId: string | null

  constructor(
    message: string,
    status: number,
    options: {
      providerStatus?: string | null
      reason?: string | null
      retryAfter?: string | null
      requestId?: string | null
    } = {},
  ) {
    super(message)
    this.name = 'GtmApiError'
    this.status = status
    this.providerStatus = options.providerStatus ?? null
    this.reason = options.reason ?? null
    this.retryAfter = options.retryAfter ?? null
    this.requestId = options.requestId ?? null
  }
}

export interface GoogleTagManagerClient {
  listAccounts(): Promise<GtmAccount[]>
  listContainers(accountPath: string): Promise<GtmContainer[]>
  listWorkspaces(containerPath: string): Promise<GtmWorkspace[]>
  getLiveContainerVersion(containerPath: string): Promise<GtmContainerVersion>
  getLiveSnapshot(containerPath: string): Promise<GtmContainerSnapshot>
  getWorkspaceSnapshot(workspacePath: string): Promise<GtmContainerSnapshot>
  compareLiveAndWorkspace(containerPath: string, workspacePath: string): Promise<GtmContainerComparison>
}

export type GtmGoogleAdsUnknownReason =
  | 'custom-html'
  | 'custom-template'
  | 'unsupported-tag-type'
  | 'malformed-google-ads-conversion-tag'

export type GtmGoogleAdsReviewReason =
  | 'tag-unknown'
  | 'tag-paused'
  | 'no-firing-trigger'
  | 'unresolved-firing-trigger'
  | 'url-based-trigger'
  | 'mixed-trigger-strategies'
  | 'missing-custom-event-name'
  | 'unexpected-custom-event-name'
  | 'missing-hostname-filter'
  | 'unexpected-hostname-filter'
  | 'missing-conversion-value'
  | 'missing-transaction-id'

export interface GtmGoogleAdsFieldMapping {
  parameterKey: string
  value: string
  source: 'literal' | 'variable' | 'mixed'
}

export interface GtmHostnameFilter {
  operator: string
  value: string
  negated: boolean
  matchesExpectedHostname: boolean | null
}

export interface GtmGoogleAdsConversionAssessment {
  schemaVersion: typeof GTM_GOOGLE_ADS_CONVERSION_ASSESSMENT_SCHEMA_VERSION
  recognizerVersion: typeof GTM_GOOGLE_ADS_CONVERSION_RECOGNIZER_VERSION
  recognition:
    | { status: 'recognized'; kind: 'google-ads-conversion' }
    | { status: 'unknown'; reason: GtmGoogleAdsUnknownReason }
  review: {
    status: 'pass' | 'needs-review'
    reasons: GtmGoogleAdsReviewReason[]
  }
  tag: {
    id: string | null
    name: string | null
    type: string | null
    checksum: string
  }
  conversion: null | {
    id: GtmGoogleAdsFieldMapping
    label: GtmGoogleAdsFieldMapping
    value: GtmGoogleAdsFieldMapping | null
    transactionId: GtmGoogleAdsFieldMapping | null
    currency: GtmGoogleAdsFieldMapping | null
  }
  trigger: {
    strategy: 'custom-event' | 'url-based' | 'mixed' | 'none' | 'unknown'
    firingTriggerIds: string[]
    resolvedTriggerIds: string[]
    unresolvedTriggerIds: string[]
    customEventNames: string[]
    hostnameFilters: GtmHostnameFilter[]
  }
}

export interface GtmGoogleAdsRecognizerOptions {
  expectedEventName?: string
  expectedHostname?: string
}

export interface GtmDtoAdapterOptions extends GtmGoogleAdsRecognizerOptions {
  fetchedAt?: string
}
