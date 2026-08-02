import type {
  DraftMutationResponse,
  MeasurementDraftAuthoring,
  MeasurementDraftCompilePreviewResponse,
  MeasurementDraftDiffPreviewResponse,
  MeasurementDraftResponse,
  MeasurementPlanV2PublishResponse,
  MeasurementSetupResponse,
} from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementPlanDraft,
  getApiV1ProjectsByNameMeasurementSetup,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyAssignments,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsApplySitemapSelection,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsCompilePreview,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsCreate,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsDiffPreview,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsDiscard,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsExcludeTarget,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsImportSitemap,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsPublish,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveAssignment,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveCompetitor,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveGroup,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertCompetitor,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertGroup,
  postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertTarget,
} from '@ainyc/canonry-api-client'

import { ApiError, heyClient, invokeWeb } from '../../../api.js'

export interface SitemapImportInput {
  sitemapUrl: string
  rule: {
    primary: { host: string; pathTemplate: string }
    aliases?: Array<{ host: string; pathTemplate: string }>
    excludedSlugPatterns?: Array<{ kind: 'exact' | 'prefix' | 'suffix' | 'contains'; value: string }>
  }
  exclusions?: string[]
}

export interface SitemapSelectionInput {
  discoveryIdentity: string
  action: 'create' | 'rebind' | 'ignore'
  targetKey?: string
  label?: string
}

export interface AdvancedMeasurementService {
  loadSetup(projectName: string): Promise<MeasurementSetupResponse>
  loadDraft(projectName: string): Promise<MeasurementDraftResponse>
  createDraft(projectName: string, expectedActiveRevision: number | null): Promise<DraftMutationResponse>
  importSitemap(projectName: string, etag: string, input: SitemapImportInput): Promise<DraftMutationResponse>
  applySitemapSelection(
    projectName: string,
    etag: string,
    selections: SitemapSelectionInput[],
    selectedTargetKeys: string[],
  ): Promise<DraftMutationResponse>
  applyAssignments(projectName: string, etag: string, targetKeys: string[], queryIds: string[]): Promise<DraftMutationResponse>
  removeAssignment(projectName: string, etag: string, targetKeys: string[], queryId: string): Promise<DraftMutationResponse>
  excludeTarget(projectName: string, etag: string, targetKey: string): Promise<DraftMutationResponse>
  upsertTarget(projectName: string, etag: string, target: MeasurementDraftAuthoring['targets'][number]): Promise<DraftMutationResponse>
  upsertGroup(projectName: string, etag: string, group: {
    stableKey: string
    label: string
    targetKeys: string[]
    competitors?: MeasurementDraftAuthoring['groups'][number]['competitors']
  }): Promise<DraftMutationResponse>
  removeGroup(projectName: string, etag: string, groupKey: string): Promise<DraftMutationResponse>
  upsertCompetitor(projectName: string, etag: string, input: {
    groupKey: string
    competitor: MeasurementDraftAuthoring['groups'][number]['competitors'][number]
  }): Promise<DraftMutationResponse>
  removeCompetitor(projectName: string, etag: string, groupKey: string, competitorKey: string): Promise<DraftMutationResponse>
  compilePreview(projectName: string): Promise<MeasurementDraftCompilePreviewResponse>
  diffPreview(projectName: string): Promise<MeasurementDraftDiffPreviewResponse>
  publish(projectName: string, etag: string, input: {
    expectedActiveRevision: number | null
    expectedCompiledChecksum: string
  }): Promise<MeasurementPlanV2PublishResponse>
  discard(projectName: string, etag: string): Promise<{ discarded: boolean }>
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function mutationHeaders(etag: string) {
  return {
    'If-Match': etag,
    'Idempotency-Key': idempotencyKey(),
  }
}

export function isDraftConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.statusCode === 404 || error.statusCode === 409 || error.statusCode === 412)
}

export function setupErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && (error.statusCode === 404 || error.statusCode === 409 || error.statusCode === 412)) return fallback
  const message = error instanceof Error ? error.message.trim() : ''
  if (message && !/\b(?:target|revision|checksum|node|edge|manifest|measurement plan|stable[ -]?key)s?\b/i.test(message)) return message
  return fallback
}

export const advancedMeasurementService: AdvancedMeasurementService = {
  loadSetup: projectName => invokeWeb(() => getApiV1ProjectsByNameMeasurementSetup({
    client: heyClient,
    path: { name: projectName },
  })),
  loadDraft: projectName => invokeWeb(() => getApiV1ProjectsByNameMeasurementPlanDraft({
    client: heyClient,
    path: { name: projectName },
  })),
  createDraft: (projectName, expectedActiveRevision) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsCreate({
    client: heyClient,
    path: { name: projectName },
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { expectedActiveRevision },
  })),
  importSitemap: (projectName, etag, body) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsImportSitemap({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body,
  })),
  applySitemapSelection: (projectName, etag, selections, selectedTargetKeys) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsApplySitemapSelection({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { selections, selectedTargetKeys },
  })),
  applyAssignments: (projectName, etag, targetKeys, queryIds) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsApplyAssignments({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { targetKeys, queryIds },
  })),
  removeAssignment: (projectName, etag, targetKeys, queryId) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveAssignment({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { targetKeys, queryId },
  })),
  excludeTarget: (projectName, etag, targetKey) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsExcludeTarget({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { targetKey, cleanup: 'assignments-and-group-memberships' },
  })),
  upsertTarget: (projectName, etag, target) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertTarget({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { target },
  })),
  upsertGroup: (projectName, etag, group) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertGroup({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { group },
  })),
  removeGroup: (projectName, etag, groupKey) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveGroup({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { groupKey },
  })),
  upsertCompetitor: (projectName, etag, body) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsUpsertCompetitor({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body,
  })),
  removeCompetitor: (projectName, etag, groupKey, competitorKey) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsRemoveCompetitor({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body: { groupKey, competitorKey },
  })),
  compilePreview: projectName => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsCompilePreview({
    client: heyClient,
    path: { name: projectName },
  })),
  diffPreview: projectName => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsDiffPreview({
    client: heyClient,
    path: { name: projectName },
  })),
  publish: (projectName, etag, body) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsPublish({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
    body,
  })),
  discard: (projectName, etag) => invokeWeb(() => postApiV1ProjectsByNameMeasurementPlanDraftActionsDiscard({
    client: heyClient,
    path: { name: projectName },
    headers: mutationHeaders(etag),
  })),
}
