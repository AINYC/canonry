import crypto from 'node:crypto'
import { and, desc, eq, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  conversionTrackingContracts,
  googleAdsConnections,
  googleAdsRawSnapshots,
  gtmConnections,
  gtmRawSnapshots,
  projects,
  runs,
} from '@ainyc/canonry-db'
import {
  GOOGLE_MARKETING_LIVE_READ_SCOPE,
  GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX,
  GOOGLE_MARKETING_WRITE_SCOPE,
  GoogleAdsConnectionStates,
  GoogleAdsSnapshotKinds,
  GoogleMarketingProviders,
  GtmConnectionStates,
  GtmSnapshotKinds,
  RunKinds,
  RunStatuses,
  RunTriggers,
  alreadyExists,
  canonicalizeGoogleAdsCustomerSelection,
  canonicalizeGtmAccountId,
  canonicalizeGtmResourceSelection,
  conversionTrackingContractSchema,
  conversionTrackingContractWriteRequestSchema,
  conversionTrackingIntegrityAssessmentDtoSchema,
  googleAdsAccessibleCustomersResponseSchema,
  googleAdsCustomerSelectionRequestSchema,
  googleAdsRawSnapshotDtoSchema,
  googleMarketingOAuthConnectRequestSchema,
  googleMarketingProviderSchema,
  forbidden,
  gtmAccountsResponseSchema,
  gtmContainerListResponseSchema,
  gtmRawSnapshotDtoSchema,
  gtmResourceSelectionRequestSchema,
  gtmWorkspaceListResponseSchema,
  hostOf,
  notFound,
  notImplemented,
  providerError,
  quotaExceeded,
  validationError,
  type ConversionTrackingContract,
  type ConversionTrackingContractWriteRequest,
  type ConversionTrackingIntegrityAssessmentDto,
  type GoogleAdsAccessibleCustomerDto,
  type GoogleAdsAccessibleCustomersResponse,
  type GoogleAdsConnectionMetadataDto,
  type GoogleAdsConnectionStatusDto,
  type GoogleAdsRawSnapshotDto,
  type GoogleMarketingProvider,
  type GtmAccountsResponse,
  type GtmConnectionMetadataDto,
  type GtmConnectionStatusDto,
  type GtmContainerListResponse,
  type GtmRawSnapshotDto,
  type GtmWorkspaceListResponse,
} from '@ainyc/canonry-contracts'
import { assertNotProjectScoped, requireAdminSession, requireBroadInstanceKey, requireScope } from './auth.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import { assertSameOriginWrite } from './same-origin.js'
import {
  buildSignedGoogleOAuthState,
  GOOGLE_OAUTH_STATE_MAX_AGE_MS,
  verifySignedGoogleOAuthState,
} from './google-oauth-state.js'
import { parseCookieHeader } from './user-session.js'

/** A stable, project-local key for injected secret and provider adapters. */
export interface GoogleMarketingProjectRef {
  id: string
  name: string
}

/**
 * Private OAuth material. This type is deliberately local to the route seam:
 * it is accepted from an injected store and never serialized, audited, or
 * persisted through the Canonry database.
 */
export interface GoogleMarketingStoredCredential {
  accessToken: string | null
  refreshToken?: string | null
  expiresAt?: string | null
  scopes: string[]
  /** Google Ads only. Never returned from an API route. */
  developerToken?: string | null
  createdAt: string
  updatedAt: string
}

/** Project-scoped private credential storage (normally Canonry config). */
export interface GoogleMarketingCredentialStore {
  get(project: GoogleMarketingProjectRef, provider: GoogleMarketingProvider): GoogleMarketingStoredCredential | undefined
  /**
   * Persist the private credential. When supplied, the returned compensator
   * restores the prior durable credential if the caller's following database
   * transaction cannot commit.
   */
  upsert(project: GoogleMarketingProjectRef, provider: GoogleMarketingProvider, credential: GoogleMarketingStoredCredential): void | (() => void)
  delete(project: GoogleMarketingProjectRef, provider: GoogleMarketingProvider): boolean
  /**
   * Google Ads developer tokens are install-global. This intentionally exposes
   * only presence, never the token, so a project OAuth flow can use an
   * existing host token without copying it through a project credential.
   */
  hasGoogleAdsDeveloperToken?(): boolean
}

export interface GoogleMarketingOAuthToken {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: string | null
  scopes: string[]
}

/** OAuth exchange seam; provider SDKs stay out of the shared route package. */
export interface GoogleMarketingOAuth {
  authorizationUrl(input: {
    provider: GoogleMarketingProvider
    redirectUri: string
    state: string
    scopes: readonly string[]
  }): string | Promise<string>
  exchangeCode(input: {
    provider: GoogleMarketingProvider
    code: string
    redirectUri: string
  }): Promise<GoogleMarketingOAuthToken>
}

/** Read-only provider discovery seam. It accepts no caller-provided credential. */
export interface GoogleMarketingLiveReader {
  listGoogleAdsCustomers(project: GoogleMarketingProjectRef): Promise<GoogleAdsAccessibleCustomersResponse>
  listGtmAccounts(project: GoogleMarketingProjectRef): Promise<GtmAccountsResponse>
  listGtmContainers(project: GoogleMarketingProjectRef, accountId: string): Promise<GtmContainerListResponse>
  listGtmWorkspaces(project: GoogleMarketingProjectRef, accountId: string, containerId: string): Promise<GtmWorkspaceListResponse>
}

/** Exact stored evidence handed to the pure integrity evaluator. */
export interface ConversionTrackingIntegrityInput {
  project: GoogleMarketingProjectRef
  contract: ConversionTrackingContract
  googleAdsSnapshot: GoogleAdsRawSnapshotDto | null
  gtmSnapshot: GtmRawSnapshotDto | null
}

export interface GoogleMarketingRoutesOptions {
  /** Private OAuth tokens/developer token. Never Canonry DB storage. */
  googleMarketingCredentialStore?: GoogleMarketingCredentialStore
  /** Provider-specific OAuth URL + code exchange implementation. */
  googleMarketingOAuth?: GoogleMarketingOAuth
  /** Provider OAuth scopes, injected by the host to avoid integration deps here. */
  googleMarketingOAuthScopes?: Partial<Record<GoogleMarketingProvider, readonly string[]>>
  /** Bounded read-only discovery adapter. */
  googleMarketingLiveReader?: GoogleMarketingLiveReader
  /** Pure integrity evaluator; api-routes does not import a runtime cycle. */
  assessConversionTrackingIntegrity?: (
    input: ConversionTrackingIntegrityInput,
  ) => Promise<ConversionTrackingIntegrityAssessmentDto> | ConversionTrackingIntegrityAssessmentDto
  /** Called only after the queued Google Ads sync run commits. */
  onGoogleAdsSyncRequested?: (runId: string, projectId: string) => void | Promise<void>
  /** Called only after the queued GTM sync run commits. */
  onGtmSyncRequested?: (runId: string, projectId: string) => void | Promise<void>
  /** Shared HMAC secret for the short-lived OAuth callback state. */
  googleStateSecret?: string
  /** Public URL for OAuth redirect URIs (overrides request-header detection). */
  publicUrl?: string
  /** API route prefix (default: `/api/v1`). */
  routePrefix?: string
}

const snapshotPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX).optional(),
  cursor: z.string().min(1).optional(),
}).strict()

const oauthStateSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  provider: googleMarketingProviderSchema,
  redirectUri: z.string().url(),
  nonce: z.string().regex(/^[\w-]{43}$/),
  issuedAt: z.number(),
}).strict()

type GoogleMarketingOAuthState = z.infer<typeof oauthStateSchema>

/** Keep pending authorization material small and automatically short-lived. */
const GOOGLE_MARKETING_OAUTH_PENDING_FLOW_MAX = 256
const GOOGLE_MARKETING_OAUTH_COOKIE_PREFIX = 'canonry_google_marketing_oauth_'

interface GoogleMarketingOAuthInitiator {
  kind: 'api-key' | 'user' | null
  id: string | null
  projectId: string | null
  viaCookie: boolean
}

interface PendingGoogleMarketingOAuthFlow {
  nonce: string
  generation: string
  projectId: string
  projectName: string
  provider: GoogleMarketingProvider
  redirectUri: string
  expiresAtMs: number
  initiator: GoogleMarketingOAuthInitiator
  /** Separate browser-held secret; never appears in the OAuth URL/state. */
  browserNonce: string
  /** Present only when a broad instance authority supplied a new global token. */
  developerToken?: string
}

interface PendingGoogleMarketingOAuthConfirmation {
  id: string
  flow: PendingGoogleMarketingOAuthFlow
  tokens: GoogleMarketingOAuthToken
  expiresAtMs: number
}

function oauthInitiator(request: FastifyRequest): GoogleMarketingOAuthInitiator {
  const principal = request.principal
  return {
    kind: principal?.kind ?? null,
    id: principal?.id ?? null,
    projectId: principal?.projectId ?? null,
    viaCookie: principal?.viaCookie ?? false,
  }
}

function sameOAuthInitiator(
  expected: GoogleMarketingOAuthInitiator,
  actual: GoogleMarketingOAuthInitiator,
): boolean {
  return expected.kind === actual.kind
    && expected.id === actual.id
    && expected.projectId === actual.projectId
    && expected.viaCookie === actual.viaCookie
}

/**
 * The OAuth callback must be public so Google can deliver the code. A signed
 * state establishes integrity, while this process-local store makes the state
 * a short-lived, single-use capability. `consume` deletes before the first
 * await in the callback, so concurrent/replayed callbacks cannot exchange or
 * persist a second code.
 */
class PendingGoogleMarketingOAuthFlows {
  #flows = new Map<string, PendingGoogleMarketingOAuthFlow>()
  #confirmations = new Map<string, PendingGoogleMarketingOAuthConfirmation>()
  #currentGenerations = new Map<string, string>()

  create(flow: PendingGoogleMarketingOAuthFlow, nowMs = Date.now()): void {
    this.prune(nowMs)
    const replacesExisting = [...this.#flows.values()].some(existing =>
      existing.projectId === flow.projectId && existing.provider === flow.provider)
    if (this.#flows.size >= GOOGLE_MARKETING_OAUTH_PENDING_FLOW_MAX && !replacesExisting) {
      throw quotaExceeded('Google Marketing OAuth starts')
    }
    this.revoke(flow.projectId, flow.provider)
    this.#currentGenerations.set(this.generationKey(flow.projectId, flow.provider), flow.generation)
    this.#flows.set(flow.nonce, flow)
  }

  consume(
    state: GoogleMarketingOAuthState,
    browserNonce: string | undefined,
    nowMs = Date.now(),
  ): PendingGoogleMarketingOAuthFlow | null {
    this.prune(nowMs)
    const flow = this.#flows.get(state.nonce)
    if (!flow) return null

    // Do not burn a legitimate browser's flow if a leaked URL is opened in a
    // different browser. Only the browser that received the HttpOnly binding
    // cookie can consume it.
    if (!sameOpaqueNonce(browserNonce, flow.browserNonce)) return null

    if (!this.isCurrent(flow)) {
      this.#flows.delete(state.nonce)
      return null
    }

    // Deleting before binding checks is intentional: a callback attempt gets
    // one chance, including malformed/failed provider callbacks.
    this.#flows.delete(state.nonce)
    if (
      flow.projectId !== state.projectId
      || flow.projectName !== state.projectName
      || flow.provider !== state.provider
      || flow.redirectUri !== state.redirectUri
      || flow.expiresAtMs <= nowMs
    ) {
      this.finish(flow)
      return null
    }
    return flow
  }

  createConfirmation(
    flow: PendingGoogleMarketingOAuthFlow,
    tokens: GoogleMarketingOAuthToken,
    nowMs = Date.now(),
  ): string | null {
    this.prune(nowMs)
    if (!this.isCurrent(flow)) return null
    if (this.#confirmations.size >= GOOGLE_MARKETING_OAUTH_PENDING_FLOW_MAX) {
      throw quotaExceeded('Google Marketing OAuth confirmations')
    }
    const id = crypto.randomBytes(32).toString('base64url')
    this.#confirmations.set(id, {
      id,
      flow,
      tokens,
      expiresAtMs: nowMs + GOOGLE_OAUTH_STATE_MAX_AGE_MS,
    })
    return id
  }

  consumeConfirmation(
    id: string,
    initiator: GoogleMarketingOAuthInitiator,
    nowMs = Date.now(),
  ): PendingGoogleMarketingOAuthConfirmation | null {
    this.prune(nowMs)
    const confirmation = this.#confirmations.get(id)
    if (!confirmation || !sameOAuthInitiator(confirmation.flow.initiator, initiator)) return null
    this.#confirmations.delete(id)
    return confirmation
  }

  revoke(projectId: string, provider: GoogleMarketingProvider): void {
    for (const [nonce, flow] of this.#flows) {
      if (flow.projectId === projectId && flow.provider === provider) this.#flows.delete(nonce)
    }
    for (const [id, confirmation] of this.#confirmations) {
      if (confirmation.flow.projectId === projectId && confirmation.flow.provider === provider) {
        this.#confirmations.delete(id)
      }
    }
    this.#currentGenerations.delete(this.generationKey(projectId, provider))
  }

  isCurrent(flow: PendingGoogleMarketingOAuthFlow): boolean {
    return this.#currentGenerations.get(this.generationKey(flow.projectId, flow.provider)) === flow.generation
  }

  finish(flow: PendingGoogleMarketingOAuthFlow): void {
    const key = this.generationKey(flow.projectId, flow.provider)
    if (this.#currentGenerations.get(key) === flow.generation) this.#currentGenerations.delete(key)
  }

  private prune(nowMs: number): void {
    for (const [nonce, flow] of this.#flows) {
      if (flow.expiresAtMs <= nowMs) {
        this.#flows.delete(nonce)
        this.finish(flow)
      }
    }
    for (const [id, confirmation] of this.#confirmations) {
      if (confirmation.expiresAtMs <= nowMs) {
        this.#confirmations.delete(id)
        this.finish(confirmation.flow)
      }
    }
  }

  private generationKey(projectId: string, provider: GoogleMarketingProvider): string {
    return `${projectId}\u0000${provider}`
  }
}

function sameOpaqueNonce(actual: string | undefined, expected: string): boolean {
  if (!actual || !/^[\w-]{43}$/.test(actual)) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

function oauthBindingCookieName(nonce: string): string {
  return `${GOOGLE_MARKETING_OAUTH_COOKIE_PREFIX}${nonce}`
}

function oauthCallbackPath(opts: GoogleMarketingRoutesOptions): string {
  return `${(opts.routePrefix ?? '/api/v1').replace(/\/$/, '')}/google-marketing/callback`
}

function serializeOAuthBindingCookie(input: {
  nonce: string
  value: string | null
  secure: boolean
  opts: GoogleMarketingRoutesOptions
}): string {
  const parts = [
    `${oauthBindingCookieName(input.nonce)}=${input.value ? encodeURIComponent(input.value) : ''}`,
    `Path=${oauthCallbackPath(input.opts)}`,
    'HttpOnly',
    'SameSite=Lax',
    input.value ? `Max-Age=${Math.ceil(GOOGLE_OAUTH_STATE_MAX_AGE_MS / 1_000)}` : 'Max-Age=0',
  ]
  if (input.secure) parts.push('Secure')
  return parts.join('; ')
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const current = reply.getHeader('set-cookie')
  const cookies = Array.isArray(current)
    ? current.map(String)
    : current === undefined ? [] : [String(current)]
  reply.header('set-cookie', [...cookies, value])
}

type SnapshotCursor = { capturedAt: string; id: string }

function encodeSnapshotCursor(cursor: SnapshotCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeSnapshotCursor(value: string | undefined): SnapshotCursor | null {
  if (!value) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical cursor')
    const parsed = z.object({ capturedAt: z.string().min(1), id: z.string().min(1) }).strict().parse(JSON.parse(decoded.toString()))
    return parsed
  } catch {
    throw validationError('Invalid Google Marketing snapshot cursor.')
  }
}

function asProjectRef(project: { id: string; name: string }): GoogleMarketingProjectRef {
  return { id: project.id, name: project.name }
}

function normalizeConversionTrackingContractWrite(
  input: ConversionTrackingContractWriteRequest,
): ConversionTrackingContractWriteRequest {
  return {
    ...input,
    runtime: {
      ...input.runtime,
      // The OpenAPI schema stays validation-only; canonical storage happens at
      // this write boundary so JSON Schema generation never encounters a Zod transform.
      productionHosts: input.runtime.productionHosts.map(host => hostOf(host)!),
    },
  }
}

function requiredCredential(
  opts: GoogleMarketingRoutesOptions,
  project: GoogleMarketingProjectRef,
  provider: GoogleMarketingProvider,
): GoogleMarketingStoredCredential {
  const credential = opts.googleMarketingCredentialStore?.get(project, provider)
  if (!credential?.accessToken) {
    throw validationError(`No ${provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'Google Tag Manager'} OAuth connection is available for this project.`)
  }
  return credential
}

function requireCredentialStore(opts: GoogleMarketingRoutesOptions): GoogleMarketingCredentialStore {
  if (!opts.googleMarketingCredentialStore) {
    throw validationError('Google Marketing credential storage is not configured for this deployment.')
  }
  return opts.googleMarketingCredentialStore
}

function requireLiveReader(opts: GoogleMarketingRoutesOptions): GoogleMarketingLiveReader {
  if (!opts.googleMarketingLiveReader) {
    throw notImplemented('Google Marketing live discovery is not configured for this deployment.')
  }
  return opts.googleMarketingLiveReader
}

function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } },
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw validationError(`Invalid ${label} request.`, { issues: parsed.error.issues })
  return parsed.data
}

function toGoogleAdsConnectionMetadata(row: typeof googleAdsConnections.$inferSelect): GoogleAdsConnectionMetadataDto {
  return {
    id: row.id,
    projectId: row.projectId,
    scopes: row.scopes,
    selection: {
      loginCustomerId: row.selectedLoginCustomerId,
      customerId: row.selectedCustomerId,
      // Keep the public DTO backward-compatible; private generation and
      // snapshot-ID anchors decide whether stored evidence is current.
      selectedAt: row.lastValidatedAt,
    },
    lastValidatedAt: row.lastValidatedAt,
    lastInventorySnapshotAt: row.lastInventorySnapshotAt,
    lastMetricsSnapshotAt: row.lastMetricsSnapshotAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toGtmConnectionMetadata(row: typeof gtmConnections.$inferSelect): GtmConnectionMetadataDto {
  return {
    id: row.id,
    projectId: row.projectId,
    scopes: row.scopes,
    selection: {
      accountId: row.selectedAccountId,
      containerId: row.selectedContainerId,
      workspaceId: row.selectedWorkspaceId,
      selectedAt: row.lastValidatedAt,
    },
    lastValidatedAt: row.lastValidatedAt,
    lastSnapshotAt: row.lastSnapshotAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toGoogleAdsSnapshotMetadata(row: typeof googleAdsRawSnapshots.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    connectionId: row.connectionId,
    runId: row.runId,
    kind: row.kind,
    customerId: row.customerId,
    payloadChecksum: row.payloadChecksum,
    rawPayloadSha256: row.rawPayloadSha256,
    rawPayloadBytes: row.rawPayloadBytes,
    redactedFieldCount: row.redactedFieldCount,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  }
}

function toGtmSnapshotMetadata(row: typeof gtmRawSnapshots.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    connectionId: row.connectionId,
    runId: row.runId,
    kind: row.kind,
    accountId: row.accountId,
    containerId: row.containerId,
    workspaceId: row.workspaceId,
    payloadChecksum: row.payloadChecksum,
    rawPayloadSha256: row.rawPayloadSha256,
    rawPayloadBytes: row.rawPayloadBytes,
    redactedFieldCount: row.redactedFieldCount,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  }
}

function toGoogleAdsSnapshot(row: typeof googleAdsRawSnapshots.$inferSelect): GoogleAdsRawSnapshotDto | null {
  const parsed = googleAdsRawSnapshotDtoSchema.safeParse({
    metadata: toGoogleAdsSnapshotMetadata(row),
    payload: row.payload,
  })
  return parsed.success ? parsed.data : null
}

function toGtmSnapshot(row: typeof gtmRawSnapshots.$inferSelect): GtmRawSnapshotDto | null {
  const parsed = gtmRawSnapshotDtoSchema.safeParse({
    metadata: toGtmSnapshotMetadata(row),
    payload: row.payload,
  })
  return parsed.success ? parsed.data : null
}

interface GoogleAdsCustomerSnapshotProvenance {
  connectionId: string
  customerId: string
  loginCustomerId: string | null
  lastCustomerSnapshotId: string | null
}

function selectedGoogleAdsCustomer(
  app: FastifyInstance,
  projectId: string,
  selection: GoogleAdsCustomerSnapshotProvenance,
): GoogleAdsAccessibleCustomerDto | null {
  if (!selection.lastCustomerSnapshotId) return null
  const row = app.db.select().from(googleAdsRawSnapshots)
    .where(and(
      eq(googleAdsRawSnapshots.projectId, projectId),
      eq(googleAdsRawSnapshots.id, selection.lastCustomerSnapshotId),
      eq(googleAdsRawSnapshots.connectionId, selection.connectionId),
      eq(googleAdsRawSnapshots.customerId, selection.customerId),
      eq(googleAdsRawSnapshots.kind, GoogleAdsSnapshotKinds['accessible-customers']),
    ))
    .get()
  if (!row) return null
  const snapshot = toGoogleAdsSnapshot(row)
  if (
    !snapshot
    || snapshot.payload.kind !== GoogleAdsSnapshotKinds['accessible-customers']
    || snapshot.metadata.id !== selection.lastCustomerSnapshotId
    || snapshot.metadata.connectionId !== selection.connectionId
    || snapshot.metadata.customerId !== selection.customerId
    || snapshot.payload.data.selection.customerId !== selection.customerId
    || snapshot.payload.data.selection.loginCustomerId !== selection.loginCustomerId
  ) return null
  return snapshot.payload.data.customers.find(customer => customer.customerId === selection.customerId) ?? null
}

interface GtmSnapshotProvenance {
  connectionId: string
  accountId: string
  containerId: string
  workspaceId: string | null
  lastSnapshotId: string | null
  lastSnapshotAt: string | null
}

/**
 * A graph is current only when the connection's durable snapshot anchor names
 * this exact selection. Timestamp ordering alone is not a generation boundary:
 * a workspace reselection and the prior snapshot can share one millisecond.
 */
function hasMatchingGtmGraphEvidence(
  app: FastifyInstance,
  projectId: string,
  selection: GtmSnapshotProvenance,
): boolean {
  if (!selection.lastSnapshotId || !selection.lastSnapshotAt) return false
  const conditions: SQL[] = [
    eq(gtmRawSnapshots.projectId, projectId),
    eq(gtmRawSnapshots.id, selection.lastSnapshotId),
    eq(gtmRawSnapshots.connectionId, selection.connectionId),
    eq(gtmRawSnapshots.accountId, selection.accountId),
    eq(gtmRawSnapshots.containerId, selection.containerId),
    eq(gtmRawSnapshots.capturedAt, selection.lastSnapshotAt),
  ]
  conditions.push(selection.workspaceId === null
    ? isNull(gtmRawSnapshots.workspaceId)
    : eq(gtmRawSnapshots.workspaceId, selection.workspaceId))
  const row = app.db.select().from(gtmRawSnapshots).where(and(...conditions)).get()
  if (!row) return false
  const snapshot = toGtmSnapshot(row)
  return Boolean(
    snapshot
    && snapshot.metadata.id === selection.lastSnapshotId
    && snapshot.metadata.connectionId === selection.connectionId
    && snapshot.metadata.accountId === selection.accountId
    && snapshot.metadata.containerId === selection.containerId
    && snapshot.metadata.workspaceId === selection.workspaceId
    && snapshot.metadata.capturedAt === selection.lastSnapshotAt
    && snapshot.payload.kind === GtmSnapshotKinds.container
  )
}

function googleAdsStatus(
  app: FastifyInstance,
  opts: GoogleMarketingRoutesOptions,
  project: GoogleMarketingProjectRef,
): GoogleAdsConnectionStatusDto {
  const credential = opts.googleMarketingCredentialStore?.get(project, GoogleMarketingProviders['google-ads'])
  const row = app.db.select().from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, project.id)).get()
  if (!credential?.accessToken || !row) {
    return {
      connected: false,
      status: GoogleAdsConnectionStates['not-connected'],
      connection: null,
      selectedCustomer: null,
    }
  }

  const connection = toGoogleAdsConnectionMetadata(row)
  if (!connection.selection.customerId) {
    return {
      connected: true,
      status: GoogleAdsConnectionStates['selection-required'],
      connection,
      selectedCustomer: null,
    }
  }

  // The status DTO must never pretend that a hand-entered ID is a fully known
  // provider customer. It becomes connected only once an append-only, safe
  // discovery observation proves the selected customer shape.
  const selectedCustomer = selectedGoogleAdsCustomer(app, project.id, {
    connectionId: row.id,
    customerId: connection.selection.customerId,
    loginCustomerId: connection.selection.loginCustomerId,
    lastCustomerSnapshotId: row.lastCustomerSnapshotId,
  })
  if (!selectedCustomer) {
    return {
      connected: true,
      status: GoogleAdsConnectionStates['selection-required'],
      connection,
      selectedCustomer: null,
    }
  }
  return {
    connected: true,
    status: GoogleAdsConnectionStates.connected,
    connection,
    selectedCustomer,
  }
}

function gtmStatus(
  app: FastifyInstance,
  opts: GoogleMarketingRoutesOptions,
  project: GoogleMarketingProjectRef,
): GtmConnectionStatusDto {
  const credential = opts.googleMarketingCredentialStore?.get(project, GoogleMarketingProviders.gtm)
  const row = app.db.select().from(gtmConnections)
    .where(eq(gtmConnections.projectId, project.id)).get()
  if (!credential?.accessToken || !row) {
    return {
      connected: false,
      status: GtmConnectionStates['not-connected'],
      connection: null,
      selection: null,
    }
  }

  const connection = toGtmConnectionMetadata(row)
  const selection = connection.selection
  if (!selection.accountId || !selection.containerId) {
    return {
      connected: true,
      status: GtmConnectionStates['selection-required'],
      connection,
      selection,
    }
  }
  const evidence = hasMatchingGtmGraphEvidence(app, project.id, {
    connectionId: row.id,
    accountId: selection.accountId,
    containerId: selection.containerId,
    workspaceId: selection.workspaceId,
    lastSnapshotId: row.lastSnapshotId,
    lastSnapshotAt: row.lastSnapshotAt,
  })
  if (!evidence) {
    return {
      connected: true,
      status: GtmConnectionStates.stale,
      connection,
      selection,
    }
  }
  return {
    connected: true,
    status: GtmConnectionStates.connected,
    connection,
    selection,
  }
}

function queuedRun(projectId: string, kind: typeof RunKinds['google-ads-sync'] | typeof RunKinds['gtm-sync']) {
  const createdAt = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    projectId,
    kind,
    status: RunStatuses.queued,
    trigger: RunTriggers.manual,
    createdAt,
  }
}

function enqueueAfterCommit(
  app: FastifyInstance,
  callback: ((runId: string, projectId: string) => void | Promise<void>) | undefined,
  runId: string,
  projectId: string,
  label: string,
): void {
  if (!callback) return
  void Promise.resolve(callback(runId, projectId)).catch(() => {
    // Never return a private provider/config error from a committed sync
    // request. The host runner owns retry/failure stamping for the run.
    app.log.error({ runId, projectId, label }, 'Google Marketing sync dispatch failed after commit')
  })
}

function latestGoogleAdsSnapshot(app: FastifyInstance, projectId: string): GoogleAdsRawSnapshotDto | null {
  const connection = app.db.select().from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId)).get()
  if (!connection?.selectedCustomerId || !connection.lastInventorySnapshotId || !connection.lastInventorySnapshotAt) return null
  const conditions: SQL[] = [
    eq(googleAdsRawSnapshots.projectId, projectId),
    eq(googleAdsRawSnapshots.id, connection.lastInventorySnapshotId),
    eq(googleAdsRawSnapshots.connectionId, connection.id),
    eq(googleAdsRawSnapshots.customerId, connection.selectedCustomerId),
    eq(googleAdsRawSnapshots.kind, GoogleAdsSnapshotKinds.inventory),
    eq(googleAdsRawSnapshots.capturedAt, connection.lastInventorySnapshotAt),
  ]
  const row = app.db.select().from(googleAdsRawSnapshots).where(and(...conditions)).get()
  const snapshot = row ? toGoogleAdsSnapshot(row) : null
  if (
    !snapshot
    || snapshot.metadata.id !== connection.lastInventorySnapshotId
    || snapshot.metadata.connectionId !== connection.id
    || snapshot.metadata.customerId !== connection.selectedCustomerId
    || snapshot.metadata.capturedAt !== connection.lastInventorySnapshotAt
    || snapshot.payload.kind !== GoogleAdsSnapshotKinds.inventory
    || snapshot.payload.data.customerId !== connection.selectedCustomerId
  ) return null
  return snapshot
}

function latestGtmSnapshot(app: FastifyInstance, projectId: string): GtmRawSnapshotDto | null {
  const connection = app.db.select().from(gtmConnections)
    .where(eq(gtmConnections.projectId, projectId)).get()
  if (!connection?.selectedAccountId || !connection.selectedContainerId || !connection.lastSnapshotId || !connection.lastSnapshotAt) return null
  const conditions: SQL[] = [
    eq(gtmRawSnapshots.projectId, projectId),
    eq(gtmRawSnapshots.id, connection.lastSnapshotId),
    eq(gtmRawSnapshots.connectionId, connection.id),
    eq(gtmRawSnapshots.accountId, connection.selectedAccountId),
    eq(gtmRawSnapshots.containerId, connection.selectedContainerId),
    eq(gtmRawSnapshots.capturedAt, connection.lastSnapshotAt),
    // The sync runtime persists one sanitized `container` envelope holding
    // both live and optional draft graphs. A standalone `live` row is a
    // contract type for future importers, not the normal sync artifact.
    eq(gtmRawSnapshots.kind, GtmSnapshotKinds.container),
  ]
  conditions.push(connection.selectedWorkspaceId === null
    ? isNull(gtmRawSnapshots.workspaceId)
    : eq(gtmRawSnapshots.workspaceId, connection.selectedWorkspaceId))
  const row = app.db.select().from(gtmRawSnapshots).where(and(...conditions)).get()
  const snapshot = row ? toGtmSnapshot(row) : null
  if (
    !snapshot
    || snapshot.metadata.id !== connection.lastSnapshotId
    || snapshot.metadata.connectionId !== connection.id
    || snapshot.metadata.accountId !== connection.selectedAccountId
    || snapshot.metadata.containerId !== connection.selectedContainerId
    || snapshot.metadata.workspaceId !== connection.selectedWorkspaceId
    || snapshot.metadata.capturedAt !== connection.lastSnapshotAt
    || snapshot.payload.kind !== GtmSnapshotKinds.container
  ) return null
  return snapshot
}

function toConversionTrackingContract(row: typeof conversionTrackingContracts.$inferSelect): ConversionTrackingContract {
  const parsed = conversionTrackingContractSchema.safeParse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    eventName: row.eventName,
    googleAds: row.googleAds,
    gtm: row.gtm,
    runtime: row.runtime,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  if (!parsed.success) throw providerError('Stored conversion tracking contract is invalid.')
  return parsed.data
}

function resolveRedirectUri(
  request: FastifyRequest,
  publicUrl: string | undefined,
  opts: GoogleMarketingRoutesOptions,
): string {
  const configured = publicUrl ?? opts.publicUrl
  let origin: string
  let callbackPath: string
  if (configured) {
    origin = configured.replace(/\/$/, '')
    // A configured public URL is the deployment base, which can already
    // include a mount path. OAuth callbacks remain under the public API path.
    callbackPath = '/api/v1/google-marketing/callback'
  } else {
    const protoHeader = request.headers['x-forwarded-proto']
    const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)?.split(',')[0]?.trim()
    const safeProto = proto === 'https' || proto === 'http' ? proto : 'http'
    const host = request.headers.host
    origin = `${safeProto}://${host ?? 'localhost:4100'}`
    callbackPath = `${(opts.routePrefix ?? '/api/v1').replace(/\/$/, '')}/google-marketing/callback`
  }
  const redirectUri = `${origin}${callbackPath}`
  try {
    const parsed = new URL(redirectUri)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported redirect protocol')
  } catch {
    throw validationError('Invalid Google Marketing OAuth public URL.')
  }
  return redirectUri
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!))
}

function oauthHtml(title: string, message: string): string {
  return `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p style="color:#888">You can close this window.</p></body></html>`
}

function oauthConfirmationPath(opts: GoogleMarketingRoutesOptions, confirmationId: string): string {
  return `${oauthCallbackPath(opts)}/confirm/${encodeURIComponent(confirmationId)}`
}

function oauthConfirmationHtml(input: {
  provider: GoogleMarketingProvider
  projectName: string
  confirmationId: string
  opts: GoogleMarketingRoutesOptions
}): string {
  const label = input.provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'Google Tag Manager'
  const action = oauthConfirmationPath(input.opts, input.confirmationId)
  return `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Confirm connection</h2><p>Connect ${escapeHtml(label)} to ${escapeHtml(input.projectName)}?</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Confirm connection</button></form><p style="color:#888">This must be confirmed in the same signed-in browser that started the connection.</p></body></html>`
}

/**
 * First-class, read-only Google Ads + GTM API surface. Provider adapters and
 * secrets are host-injected; this plugin stores only typed selection metadata
 * and sanitized, append-only evidence rows.
 */
export async function googleMarketingRoutes(app: FastifyInstance, opts: GoogleMarketingRoutesOptions) {
  const pendingOAuthFlows = new PendingGoogleMarketingOAuthFlows()
  let stateSecret: string | null = null
  if (opts.googleStateSecret !== undefined) {
    if (opts.googleStateSecret === '' || opts.googleStateSecret === 'insecure-default-secret') {
      throw new Error('googleStateSecret must be a non-empty, non-default secret to enable Google Marketing OAuth.')
    }
    stateSecret = opts.googleStateSecret
  } else {
    app.log.warn('googleStateSecret is not configured — Google Marketing OAuth connect/callback routes will not be registered.')
  }

  const requireLiveRead = (request: FastifyRequest) => {
    requireAdminSession(request)
    requireScope(request, GOOGLE_MARKETING_LIVE_READ_SCOPE)
  }
  const requireWrite = (request: FastifyRequest) => requireScope(request, GOOGLE_MARKETING_WRITE_SCOPE)

  // --- Stored connection status -------------------------------------------------

  app.get<{ Params: { name: string } }>('/projects/:name/google-ads/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return googleAdsStatus(app, opts, asProjectRef(project))
  })

  app.get<{ Params: { name: string } }>('/projects/:name/gtm/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return gtmStatus(app, opts, asProjectRef(project))
  })

  // --- OAuth --------------------------------------------------------------------

  if (stateSecret) {
    const registerOAuthConnect = (path: string, provider: GoogleMarketingProvider) => {
      app.post<{ Params: { name: string }; Body: unknown }>(path, async (request, reply) => {
        requireWrite(request)
        // OAuth code delivery is browser-bound. An Authorization-header/CLI
        // start cannot receive the HttpOnly callback cookie, so refuse it
        // rather than minting an authorization URL that can never be safely
        // confirmed. `skipAuth` test harnesses have no principal and remain
        // intentionally supported for route-level tests.
        if (request.principal && !request.principal.viaCookie) {
          throw forbidden('Google Marketing OAuth must be started from a signed-in browser.')
        }
        const body = parseBody(googleMarketingOAuthConnectRequestSchema, request.body, 'Google Marketing OAuth connect')
        if (body.provider !== provider) {
          throw validationError(`This endpoint only starts the ${provider} OAuth flow.`)
        }
        if (provider !== GoogleMarketingProviders['google-ads'] && body.developerToken !== undefined) {
          throw validationError('A Google Ads developer token cannot be supplied for a Google Tag Manager OAuth flow.')
        }
        const project = resolveProject(app.db, request.params.name)
        const store = requireCredentialStore(opts)
        const adapter = opts.googleMarketingOAuth
        if (!adapter) throw notImplemented('Google Marketing OAuth is not configured for this deployment.')
        const scopes = opts.googleMarketingOAuthScopes?.[provider]
        if (!scopes || scopes.length === 0) {
          throw validationError(`OAuth scopes for ${provider} are not configured for this deployment.`)
        }

        // A developer token changes an install-global secret, not a
        // project-local connection. A project-scoped integration key may
        // connect using a preconfigured token but can never set or replace it.
        if (provider === GoogleMarketingProviders['google-ads'] && body.developerToken !== undefined) {
          requireBroadInstanceKey(request)
        }
        const suppliedDeveloperToken = provider === GoogleMarketingProviders['google-ads']
          ? body.developerToken
          : undefined
        if (
          provider === GoogleMarketingProviders['google-ads']
          && !suppliedDeveloperToken
          && !store.hasGoogleAdsDeveloperToken?.()
        ) {
          throw validationError('A Google Ads developer token is required before connecting this project.')
        }

        const redirectUri = resolveRedirectUri(request, body.publicUrl, opts)
        const nowMs = Date.now()
        const nonce = crypto.randomBytes(32).toString('base64url')
        const browserNonce = crypto.randomBytes(32).toString('base64url')
        const state = buildSignedGoogleOAuthState({
          projectId: project.id,
          projectName: project.name,
          provider,
          redirectUri,
          nonce,
        }, stateSecret, nowMs)
        let authorizationUrl: string
        try {
          authorizationUrl = await adapter.authorizationUrl({ provider, redirectUri, state, scopes })
          new URL(authorizationUrl)
        } catch {
          throw providerError('Could not start the Google Marketing OAuth flow.')
        }

        // Do not persist a supplied developer token until the signed-in browser
        // confirms the exchanged code. The only copy before then is this bounded,
        // process-local flow entry; the signed URL contains only a nonce and
        // non-secret binding metadata.
        // A newer start replaces an unfinished start for this exact project
        // and provider, so an old callback cannot recreate a disconnected or
        // superseded connection.
        pendingOAuthFlows.create({
          nonce,
          generation: crypto.randomUUID(),
          projectId: project.id,
          projectName: project.name,
          provider,
          redirectUri,
          expiresAtMs: nowMs + GOOGLE_OAUTH_STATE_MAX_AGE_MS,
          initiator: oauthInitiator(request),
          browserNonce,
          ...(suppliedDeveloperToken ? { developerToken: suppliedDeveloperToken } : {}),
        }, nowMs)

        // The state appears in Google's authorization URL by protocol design;
        // this second, HttpOnly browser secret does not. A callback must prove
        // both values, binding the otherwise public callback to the browser
        // that began the flow. HTTP local installs cannot retain Secure cookies;
        // deployed HTTPS origins always receive one.
        appendSetCookie(reply, serializeOAuthBindingCookie({
          nonce,
          value: browserNonce,
          secure: new URL(redirectUri).protocol === 'https:',
          opts,
        }))

        writeAuditLog(app.db, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'google-marketing.oauth-started',
          entityType: 'google-marketing-connection',
          entityId: provider,
          diff: { provider },
        }))
        return {
          provider,
          authorizationUrl,
          redirectUri,
          expiresAt: null,
        }
      })
    }

    registerOAuthConnect('/projects/:name/google-ads/oauth/connect', GoogleMarketingProviders['google-ads'])
    registerOAuthConnect('/projects/:name/gtm/oauth/connect', GoogleMarketingProviders.gtm)

    app.get<{
      Querystring: { code?: string; state?: string; error?: string }
    }>('/google-marketing/callback', async (request, reply) => {
      if (!request.query.state) {
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Missing OAuth state.'))
      }
      const state = verifySignedGoogleOAuthState(request.query.state, stateSecret)
      const parsedState = oauthStateSchema.safeParse(state)
      if (!parsedState.success) {
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Invalid, expired, or tampered OAuth state.'))
      }
      // This is deliberately before code exchange and credential reads. A
      // replay, a provider-denied callback, or a failed code exchange burns
      // the capability, so it cannot later be retried with another account.
      const browserNonce = parseCookieHeader(request.headers.cookie)[oauthBindingCookieName(parsedState.data.nonce)]
      const pending = pendingOAuthFlows.consume(parsedState.data, browserNonce)
      if (!pending) {
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'OAuth state is unknown, expired, already used, or was opened in a different browser.'))
      }
      appendSetCookie(reply, serializeOAuthBindingCookie({
        nonce: parsedState.data.nonce,
        value: null,
        secure: new URL(parsedState.data.redirectUri).protocol === 'https:',
        opts,
      }))
      if (request.query.error) {
        pendingOAuthFlows.finish(pending)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Google did not approve this authorization request.'))
      }
      if (!request.query.code) {
        pendingOAuthFlows.finish(pending)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Missing OAuth code.'))
      }
      const { projectId, projectName, provider, redirectUri } = parsedState.data
      const project = app.db.select().from(projects)
        .where(eq(projects.id, projectId)).get()
      if (!project || project.name !== projectName) {
        pendingOAuthFlows.finish(pending)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Project ownership changed. Restart the OAuth flow.'))
      }
      const store = opts.googleMarketingCredentialStore
      const adapter = opts.googleMarketingOAuth
      if (!store || !adapter) {
        pendingOAuthFlows.finish(pending)
        return reply.status(500).type('text/html').send(oauthHtml('Authorization failed', 'Google Marketing OAuth is not configured.'))
      }
      let tokens: GoogleMarketingOAuthToken
      try {
        tokens = await adapter.exchangeCode({ provider, code: request.query.code, redirectUri })
      } catch {
        pendingOAuthFlows.finish(pending)
        return reply.status(502).type('text/html').send(oauthHtml('Authorization failed', 'Google rejected the OAuth code. Restart the connection flow.'))
      }

      // A disconnect or newer start can happen while Google's token endpoint
      // is awaited. Do not let that old callback resurrect credentials.
      if (!pendingOAuthFlows.isCurrent(pending)) {
        pendingOAuthFlows.finish(pending)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth flow was replaced or disconnected. Restart the connection flow.'))
      }
      // Reconnects must prove they received a token for the account just
      // authorized. Reusing the prior refresh token would silently switch the
      // connection back to that old principal when the access token expires.
      if (typeof tokens.refreshToken !== 'string' || tokens.refreshToken.trim().length === 0) {
        pendingOAuthFlows.finish(pending)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Google did not provide offline access. Restart the connection flow and approve access.'))
      }
      let confirmationId: string | null
      try {
        confirmationId = pendingOAuthFlows.createConfirmation(pending, tokens)
      } catch {
        pendingOAuthFlows.finish(pending)
        return reply.status(503).type('text/html').send(oauthHtml('Authorization failed', 'Too many pending OAuth confirmations. Restart the connection flow.'))
      }
      if (!confirmationId) {
        pendingOAuthFlows.finish(pending)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth flow was replaced or disconnected. Restart the connection flow.'))
      }
      return reply.type('text/html').send(oauthConfirmationHtml({
        provider,
        projectName: project.name,
        confirmationId,
        opts,
      }))
    })

    app.post<{ Params: { confirmationId: string } }>('/google-marketing/callback/confirm/:confirmationId', async (request, reply) => {
      // The public callback must not persist merely because Google returned a
      // code. This second, same-origin POST is the browser user's explicit
      // consent and binds the exchanged token to the initiator's identity.
      if (request.principal && !request.principal.viaCookie) {
        throw forbidden('Google Marketing OAuth confirmation requires the browser that started the connection.')
      }
      if (request.principal?.viaCookie) assertSameOriginWrite(request)
      requireAdminSession(request)
      requireWrite(request)

      const confirmation = pendingOAuthFlows.consumeConfirmation(
        request.params.confirmationId,
        oauthInitiator(request),
      )
      if (!confirmation) {
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth confirmation is unknown, expired, already used, or belongs to another browser session.'))
      }
      const { flow, tokens } = confirmation
      if (!pendingOAuthFlows.isCurrent(flow)) {
        pendingOAuthFlows.finish(flow)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth flow was replaced or disconnected. Restart the connection flow.'))
      }

      const project = app.db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
      if (!project || project.name !== flow.projectName) {
        pendingOAuthFlows.finish(flow)
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Project ownership changed. Restart the OAuth flow.'))
      }
      const store = opts.googleMarketingCredentialStore
      if (!store) {
        pendingOAuthFlows.finish(flow)
        return reply.status(500).type('text/html').send(oauthHtml('Authorization failed', 'Google Marketing OAuth is not configured.'))
      }

      const projectRef = asProjectRef(project)
      const existing = store.get(projectRef, flow.provider)
      const now = new Date().toISOString()
      let rollbackCredential: (() => void) | undefined
      try {
        // This is all synchronous after the generation check, so disconnect or
        // a newer start cannot interleave and recreate a stale connection.
        const credentialCompensator = store.upsert(projectRef, flow.provider, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt ?? existing?.expiresAt ?? null,
          scopes: tokens.scopes,
          ...(flow.provider === GoogleMarketingProviders['google-ads']
            ? { developerToken: flow.developerToken ?? null }
            : {}),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
        rollbackCredential = typeof credentialCompensator === 'function' ? credentialCompensator : undefined

        app.db.transaction((tx) => {
          if (flow.provider === GoogleMarketingProviders['google-ads']) {
            const row = tx.select().from(googleAdsConnections)
              .where(eq(googleAdsConnections.projectId, project.id)).get()
            if (row) {
              // A reconnect can authenticate a different Google principal.
              // Force a fresh selection/evidence generation before anything
              // from the prior credential can be treated as current.
              tx.update(googleAdsConnections).set({
                selectedLoginCustomerId: null, selectedCustomerId: null, selectedCustomerName: null,
                selectedCustomerCurrencyCode: null, selectedCustomerTimeZone: null, selectedCustomerStatus: null,
                selectionGeneration: sql`${googleAdsConnections.selectionGeneration} + 1`,
                scopes: tokens.scopes, lastValidatedAt: now, lastCustomerSnapshotId: null,
                lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
                lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null, updatedAt: now,
              })
                .where(eq(googleAdsConnections.id, row.id)).run()
            } else {
              tx.insert(googleAdsConnections).values({
                id: crypto.randomUUID(), projectId: project.id, scopes: tokens.scopes,
                lastValidatedAt: now, createdAt: now, updatedAt: now,
              }).run()
            }
          } else {
            const row = tx.select().from(gtmConnections)
              .where(eq(gtmConnections.projectId, project.id)).get()
            if (row) {
              tx.update(gtmConnections).set({
                selectedAccountId: null, selectedAccountName: null, selectedContainerId: null,
                selectedContainerName: null, selectedContainerPublicId: null,
                selectedWorkspaceId: null, selectedWorkspaceName: null,
                selectionGeneration: sql`${gtmConnections.selectionGeneration} + 1`,
                scopes: tokens.scopes, lastValidatedAt: now, lastSnapshotAt: null, lastSnapshotId: null,
                updatedAt: now,
              })
                .where(eq(gtmConnections.id, row.id)).run()
            } else {
              tx.insert(gtmConnections).values({
                id: crypto.randomUUID(), projectId: project.id, scopes: tokens.scopes,
                lastValidatedAt: now, createdAt: now, updatedAt: now,
              }).run()
            }
          }
          writeAuditLog(tx, {
            projectId: project.id,
            actor: 'oauth',
            action: 'google-marketing.connected',
            entityType: 'google-marketing-connection',
            entityId: flow.provider,
            diff: { provider: flow.provider },
          })
        })
      } catch (error) {
        // Private OAuth config is outside SQLite. Restore it if the public
        // connection metadata/audit transaction did not commit. A compensator
        // failure is logged but must not hide the database failure from the
        // caller.
        if (rollbackCredential) {
          try {
            rollbackCredential()
          } catch (rollbackError) {
            app.log.error({ err: rollbackError, projectId: project.id, provider: flow.provider }, 'Google Marketing OAuth credential rollback failed')
          }
        }
        throw error
      } finally {
        pendingOAuthFlows.finish(flow)
      }
      const label = flow.provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'Google Tag Manager'
      return reply.type('text/html').send(oauthHtml('Connected successfully', `${label} is now linked to this project.`))
    })
  }

  // --- Live discovery (all provider queries have both gates) -------------------

  app.get<{ Params: { name: string } }>('/projects/:name/google-ads/customers', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Ads customers')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders['google-ads'])
    const reader = requireLiveReader(opts)
    let result: GoogleAdsAccessibleCustomersResponse
    try {
      result = googleAdsAccessibleCustomersResponseSchema.parse(await reader.listGoogleAdsCustomers(projectRef))
    } catch {
      throw providerError('Google Ads customer discovery failed.')
    }
    return result
  })

  app.get<{ Params: { name: string } }>('/projects/:name/gtm/accounts', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Tag Manager accounts')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    const reader = requireLiveReader(opts)
    try {
      return gtmAccountsResponseSchema.parse(await reader.listGtmAccounts(projectRef))
    } catch {
      throw providerError('Google Tag Manager account discovery failed.')
    }
  })

  app.get<{ Params: { name: string; accountId: string } }>('/projects/:name/gtm/accounts/:accountId/containers', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Tag Manager containers')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    const accountId = canonicalizeGtmAccountId(request.params.accountId)
    if (!accountId) throw validationError('Invalid GTM account resource path.')
    const reader = requireLiveReader(opts)
    try {
      return gtmContainerListResponseSchema.parse(await reader.listGtmContainers(projectRef, accountId))
    } catch {
      throw providerError('Google Tag Manager container discovery failed.')
    }
  })

  app.get<{ Params: { name: string; accountId: string; containerId: string } }>('/projects/:name/gtm/accounts/:accountId/containers/:containerId/workspaces', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Tag Manager workspaces')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    const selection = canonicalizeGtmResourceSelection({
      accountId: request.params.accountId,
      containerId: request.params.containerId,
    })
    if (!selection) throw validationError('Invalid GTM account/container resource paths.')
    const reader = requireLiveReader(opts)
    try {
      return gtmWorkspaceListResponseSchema.parse(await reader.listGtmWorkspaces(
        projectRef,
        selection.accountId,
        selection.containerId,
      ))
    } catch {
      throw providerError('Google Tag Manager workspace discovery failed.')
    }
  })

  // --- Resource selection --------------------------------------------------------

  app.put<{ Params: { name: string }; Body: unknown }>('/projects/:name/google-ads/selection', async (request) => {
    requireWrite(request)
    const parsedBody = parseBody(googleAdsCustomerSelectionRequestSchema, request.body, 'Google Ads selection')
    const body = canonicalizeGoogleAdsCustomerSelection(parsedBody)
    if (!body) throw validationError('Invalid Google Ads selection.')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders['google-ads'])
    const existing = app.db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.projectId, project.id)).get()
    if (!existing) throw validationError('Connect Google Ads before selecting a customer.')
    const now = new Date().toISOString()
    const customerChanged = existing.selectedCustomerId !== body.customerId
    app.db.transaction((tx) => {
      tx.update(googleAdsConnections).set({
        selectedLoginCustomerId: body.loginCustomerId ?? null,
        selectedCustomerId: body.customerId,
        selectedCustomerName: customerChanged ? null : existing.selectedCustomerName,
        selectedCustomerCurrencyCode: customerChanged ? null : existing.selectedCustomerCurrencyCode,
        selectedCustomerTimeZone: customerChanged ? null : existing.selectedCustomerTimeZone,
        selectedCustomerStatus: customerChanged ? null : existing.selectedCustomerStatus,
        // A same-value write still starts a new selection generation. Do not
        // let timestamp equality reuse append-only evidence from before it.
        selectionGeneration: sql`${googleAdsConnections.selectionGeneration} + 1`,
        lastValidatedAt: now,
        lastCustomerSnapshotId: null,
        lastInventorySnapshotAt: null,
        lastInventorySnapshotId: null,
        lastMetricsSnapshotAt: null,
        lastMetricsSnapshotId: null,
        updatedAt: now,
      }).where(eq(googleAdsConnections.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'google-ads.selection-updated',
        entityType: 'google-ads-connection', entityId: existing.id,
        diff: { loginCustomerId: body.loginCustomerId ?? null, customerId: body.customerId },
      }))
    })
    return googleAdsStatus(app, opts, projectRef)
  })

  app.put<{ Params: { name: string }; Body: unknown }>('/projects/:name/gtm/selection', async (request) => {
    requireWrite(request)
    const parsedBody = parseBody(gtmResourceSelectionRequestSchema, request.body, 'GTM selection')
    const body = canonicalizeGtmResourceSelection(parsedBody)
    if (!body) throw validationError('Invalid GTM selection.')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    const existing = app.db.select().from(gtmConnections)
      .where(eq(gtmConnections.projectId, project.id)).get()
    if (!existing) throw validationError('Connect Google Tag Manager before selecting resources.')
    const now = new Date().toISOString()
    const selectedWorkspaceId = body.workspaceId ?? null
    const containerChanged = existing.selectedAccountId !== body.accountId || existing.selectedContainerId !== body.containerId
    const workspaceChanged = existing.selectedWorkspaceId !== selectedWorkspaceId
    app.db.transaction((tx) => {
      tx.update(gtmConnections).set({
        selectedAccountId: body.accountId,
        selectedAccountName: containerChanged ? null : existing.selectedAccountName,
        selectedContainerId: body.containerId,
        selectedContainerName: containerChanged ? null : existing.selectedContainerName,
        selectedContainerPublicId: containerChanged ? null : existing.selectedContainerPublicId,
        selectedWorkspaceId,
        selectedWorkspaceName: workspaceChanged ? null : existing.selectedWorkspaceName,
        selectionGeneration: sql`${gtmConnections.selectionGeneration} + 1`,
        lastValidatedAt: now,
        // Every selection write starts a new evidence generation, including a
        // same-value reselection. The timestamp alone cannot order a prior
        // snapshot and this write when both land in one millisecond.
        lastSnapshotAt: null,
        lastSnapshotId: null,
        updatedAt: now,
      }).where(eq(gtmConnections.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'gtm.selection-updated',
        entityType: 'gtm-connection', entityId: existing.id,
        diff: { accountId: body.accountId, containerId: body.containerId, workspaceId: body.workspaceId ?? null },
      }))
    })
    return gtmStatus(app, opts, projectRef)
  })

  // --- Manual sync: queue only; host performs bounded GETs + snapshot writes ---

  app.post<{ Params: { name: string } }>('/projects/:name/google-ads/sync', async (request) => {
    requireLiveRead(request)
    requireWrite(request)
    if (!opts.onGoogleAdsSyncRequested) {
      throw notImplemented('Google Ads sync is not configured for this deployment.')
    }
    const project = resolveProject(app.db, request.params.name)
    requiredCredential(opts, asProjectRef(project), GoogleMarketingProviders['google-ads'])
    const connection = app.db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.projectId, project.id)).get()
    if (!connection) throw validationError('Connect Google Ads before starting a sync.')
    const candidateRun = queuedRun(project.id, RunKinds['google-ads-sync'])
    let run: typeof runs.$inferSelect | typeof candidateRun = candidateRun
    let queued = false
    app.db.transaction((tx) => {
      const existing = tx.select().from(runs).where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['google-ads-sync']),
        or(eq(runs.status, RunStatuses.queued), eq(runs.status, RunStatuses.running)),
      )).orderBy(desc(runs.createdAt)).get()
      if (existing) {
        run = existing
        return
      }
      tx.insert(runs).values(candidateRun).run()
      queued = true
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'google-ads.sync-requested',
        entityType: 'run', entityId: run.id,
      }))
    })
    if (queued) enqueueAfterCommit(app, opts.onGoogleAdsSyncRequested, run.id, project.id, 'google-ads-sync')
    return run
  })

  app.post<{ Params: { name: string } }>('/projects/:name/gtm/sync', async (request) => {
    requireLiveRead(request)
    requireWrite(request)
    if (!opts.onGtmSyncRequested) {
      throw notImplemented('Google Tag Manager sync is not configured for this deployment.')
    }
    const project = resolveProject(app.db, request.params.name)
    requiredCredential(opts, asProjectRef(project), GoogleMarketingProviders.gtm)
    const connection = app.db.select().from(gtmConnections)
      .where(eq(gtmConnections.projectId, project.id)).get()
    if (!connection) throw validationError('Connect Google Tag Manager before starting a sync.')
    const candidateRun = queuedRun(project.id, RunKinds['gtm-sync'])
    let run: typeof runs.$inferSelect | typeof candidateRun = candidateRun
    let queued = false
    app.db.transaction((tx) => {
      const existing = tx.select().from(runs).where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['gtm-sync']),
        or(eq(runs.status, RunStatuses.queued), eq(runs.status, RunStatuses.running)),
      )).orderBy(desc(runs.createdAt)).get()
      if (existing) {
        run = existing
        return
      }
      tx.insert(runs).values(candidateRun).run()
      queued = true
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'gtm.sync-requested',
        entityType: 'run', entityId: run.id,
      }))
    })
    if (queued) enqueueAfterCommit(app, opts.onGtmSyncRequested, run.id, project.id, 'gtm-sync')
    return run
  })

  // --- Append-only sanitized snapshot reads -------------------------------------

  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; cursor?: string }
  }>('/projects/:name/google-ads/snapshots', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const query = parseBody(snapshotPageQuerySchema, request.query, 'Google Ads snapshot page')
    const cursor = decodeSnapshotCursor(query.cursor)
    const conditions: SQL[] = [eq(googleAdsRawSnapshots.projectId, project.id)]
    if (cursor) {
      conditions.push(or(
        lt(googleAdsRawSnapshots.capturedAt, cursor.capturedAt),
        and(eq(googleAdsRawSnapshots.capturedAt, cursor.capturedAt), lt(googleAdsRawSnapshots.id, cursor.id)),
      )!)
    }
    const limit = query.limit ?? 50
    const rows = app.db.select().from(googleAdsRawSnapshots).where(and(...conditions))
      .orderBy(desc(googleAdsRawSnapshots.capturedAt), desc(googleAdsRawSnapshots.id))
      .limit(limit + 1).all()
    const page = rows.slice(0, limit)
    const total = app.db.select({ total: sql<number>`COUNT(*)`.mapWith(Number).as('total') }).from(googleAdsRawSnapshots)
      .where(eq(googleAdsRawSnapshots.projectId, project.id)).get()
    return {
      snapshots: page.map(toGoogleAdsSnapshotMetadata),
      nextCursor: rows.length > limit && page.length > 0
        ? encodeSnapshotCursor({ capturedAt: page.at(-1)!.capturedAt, id: page.at(-1)!.id })
        : null,
      total: total?.total ?? 0,
    }
  })

  app.get<{ Params: { name: string; snapshotId: string } }>('/projects/:name/google-ads/snapshots/:snapshotId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(googleAdsRawSnapshots).where(and(
      eq(googleAdsRawSnapshots.projectId, project.id),
      eq(googleAdsRawSnapshots.id, request.params.snapshotId),
    )).get()
    if (!row) throw notFound('Google Ads snapshot', request.params.snapshotId)
    const snapshot = toGoogleAdsSnapshot(row)
    if (!snapshot) throw providerError('Stored Google Ads snapshot is invalid.')
    return { snapshot }
  })

  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; cursor?: string }
  }>('/projects/:name/gtm/snapshots', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const query = parseBody(snapshotPageQuerySchema, request.query, 'GTM snapshot page')
    const cursor = decodeSnapshotCursor(query.cursor)
    const conditions: SQL[] = [eq(gtmRawSnapshots.projectId, project.id)]
    if (cursor) {
      conditions.push(or(
        lt(gtmRawSnapshots.capturedAt, cursor.capturedAt),
        and(eq(gtmRawSnapshots.capturedAt, cursor.capturedAt), lt(gtmRawSnapshots.id, cursor.id)),
      )!)
    }
    const limit = query.limit ?? 50
    const rows = app.db.select().from(gtmRawSnapshots).where(and(...conditions))
      .orderBy(desc(gtmRawSnapshots.capturedAt), desc(gtmRawSnapshots.id))
      .limit(limit + 1).all()
    const page = rows.slice(0, limit)
    const total = app.db.select({ total: sql<number>`COUNT(*)`.mapWith(Number).as('total') }).from(gtmRawSnapshots)
      .where(eq(gtmRawSnapshots.projectId, project.id)).get()
    return {
      snapshots: page.map(toGtmSnapshotMetadata),
      nextCursor: rows.length > limit && page.length > 0
        ? encodeSnapshotCursor({ capturedAt: page.at(-1)!.capturedAt, id: page.at(-1)!.id })
        : null,
      total: total?.total ?? 0,
    }
  })

  app.get<{ Params: { name: string; snapshotId: string } }>('/projects/:name/gtm/snapshots/:snapshotId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(gtmRawSnapshots).where(and(
      eq(gtmRawSnapshots.projectId, project.id),
      eq(gtmRawSnapshots.id, request.params.snapshotId),
    )).get()
    if (!row) throw notFound('GTM snapshot', request.params.snapshotId)
    const snapshot = toGtmSnapshot(row)
    if (!snapshot) throw providerError('Stored GTM snapshot is invalid.')
    return { snapshot }
  })

  // --- Disconnect preserves append-only evidence, removes private credential --

  app.delete<{ Params: { name: string } }>('/projects/:name/google-ads/connection', async (request) => {
    requireWrite(request)
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    pendingOAuthFlows.revoke(project.id, GoogleMarketingProviders['google-ads'])
    const row = app.db.select().from(googleAdsConnections).where(eq(googleAdsConnections.projectId, project.id)).get()
    const removedCredential = requireCredentialStore(opts).delete(projectRef, GoogleMarketingProviders['google-ads'])
    if (row) {
      const now = new Date().toISOString()
      app.db.transaction((tx) => {
        tx.update(googleAdsConnections).set({
          selectedLoginCustomerId: null, selectedCustomerId: null, selectedCustomerName: null,
          selectedCustomerCurrencyCode: null, selectedCustomerTimeZone: null, selectedCustomerStatus: null,
          selectionGeneration: sql`${googleAdsConnections.selectionGeneration} + 1`,
          scopes: [], lastValidatedAt: null, lastCustomerSnapshotId: null,
          lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
          lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null, updatedAt: now,
        }).where(eq(googleAdsConnections.id, row.id)).run()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id, actor: 'api', action: 'google-ads.disconnected',
          entityType: 'google-ads-connection', entityId: row.id,
        }))
      })
    }
    return { provider: GoogleMarketingProviders['google-ads'], disconnected: Boolean(row) || removedCredential }
  })

  app.delete<{ Params: { name: string } }>('/projects/:name/gtm/connection', async (request) => {
    requireWrite(request)
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    pendingOAuthFlows.revoke(project.id, GoogleMarketingProviders.gtm)
    const row = app.db.select().from(gtmConnections).where(eq(gtmConnections.projectId, project.id)).get()
    const removedCredential = requireCredentialStore(opts).delete(projectRef, GoogleMarketingProviders.gtm)
    if (row) {
      const now = new Date().toISOString()
      app.db.transaction((tx) => {
        tx.update(gtmConnections).set({
          selectedAccountId: null, selectedAccountName: null, selectedContainerId: null,
          selectedContainerName: null, selectedContainerPublicId: null,
          selectedWorkspaceId: null, selectedWorkspaceName: null,
          selectionGeneration: sql`${gtmConnections.selectionGeneration} + 1`,
          scopes: [], lastValidatedAt: null, lastSnapshotAt: null, lastSnapshotId: null, updatedAt: now,
        }).where(eq(gtmConnections.id, row.id)).run()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id, actor: 'api', action: 'gtm.disconnected',
          entityType: 'gtm-connection', entityId: row.id,
        }))
      })
    }
    return { provider: GoogleMarketingProviders.gtm, disconnected: Boolean(row) || removedCredential }
  })

  // --- Conversion-tracking contract + integrity reads ---------------------------

  app.get<{ Params: { name: string } }>('/projects/:name/conversion-tracking/contracts', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return app.db.select().from(conversionTrackingContracts)
      .where(eq(conversionTrackingContracts.projectId, project.id))
      .orderBy(conversionTrackingContracts.name)
      .all()
      .map(toConversionTrackingContract)
  })

  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/conversion-tracking/contracts', async (request) => {
    requireWrite(request)
    const body = normalizeConversionTrackingContractWrite(
      parseBody(conversionTrackingContractWriteRequestSchema, request.body, 'conversion tracking contract'),
    )
    const project = resolveProject(app.db, request.params.name)
    const duplicate = app.db.select({ id: conversionTrackingContracts.id }).from(conversionTrackingContracts)
      .where(and(eq(conversionTrackingContracts.projectId, project.id), eq(conversionTrackingContracts.name, body.name))).get()
    if (duplicate) throw alreadyExists('Conversion tracking contract', body.name)
    const now = new Date().toISOString()
    const contract: ConversionTrackingContract = {
      id: crypto.randomUUID(), projectId: project.id, ...body, createdAt: now, updatedAt: now,
    }
    app.db.transaction((tx) => {
      tx.insert(conversionTrackingContracts).values(contract).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'conversion-tracking.contract-created',
        entityType: 'conversion-tracking-contract', entityId: contract.id,
        diff: { name: contract.name, eventName: contract.eventName },
      }))
    })
    return contract
  })

  app.get<{ Params: { name: string; contractId: string } }>('/projects/:name/conversion-tracking/contracts/:contractId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!row) throw notFound('Conversion tracking contract', request.params.contractId)
    return toConversionTrackingContract(row)
  })

  app.put<{ Params: { name: string; contractId: string }; Body: unknown }>('/projects/:name/conversion-tracking/contracts/:contractId', async (request) => {
    requireWrite(request)
    const body = normalizeConversionTrackingContractWrite(
      parseBody(conversionTrackingContractWriteRequestSchema, request.body, 'conversion tracking contract'),
    )
    const project = resolveProject(app.db, request.params.name)
    const existing = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!existing) throw notFound('Conversion tracking contract', request.params.contractId)
    const duplicate = app.db.select({ id: conversionTrackingContracts.id }).from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.name, body.name),
      ne(conversionTrackingContracts.id, existing.id),
    )).get()
    if (duplicate) throw alreadyExists('Conversion tracking contract', body.name)
    const updatedAt = new Date().toISOString()
    const contract: ConversionTrackingContract = {
      id: existing.id, projectId: project.id, ...body, createdAt: existing.createdAt, updatedAt,
    }
    app.db.transaction((tx) => {
      tx.update(conversionTrackingContracts).set({
        name: contract.name, eventName: contract.eventName, googleAds: contract.googleAds,
        gtm: contract.gtm, runtime: contract.runtime, updatedAt,
      }).where(eq(conversionTrackingContracts.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'conversion-tracking.contract-updated',
        entityType: 'conversion-tracking-contract', entityId: existing.id,
        diff: { name: contract.name, eventName: contract.eventName },
      }))
    })
    return contract
  })

  app.delete<{ Params: { name: string; contractId: string } }>('/projects/:name/conversion-tracking/contracts/:contractId', async (request, reply) => {
    requireWrite(request)
    const project = resolveProject(app.db, request.params.name)
    const existing = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!existing) throw notFound('Conversion tracking contract', request.params.contractId)
    app.db.transaction((tx) => {
      tx.delete(conversionTrackingContracts).where(eq(conversionTrackingContracts.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'conversion-tracking.contract-deleted',
        entityType: 'conversion-tracking-contract', entityId: existing.id,
        diff: { name: existing.name },
      }))
    })
    return reply.status(204).send()
  })

  app.get<{ Params: { name: string; contractId: string } }>('/projects/:name/conversion-tracking/contracts/:contractId/integrity', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!row) throw notFound('Conversion tracking contract', request.params.contractId)
    if (!opts.assessConversionTrackingIntegrity) {
      throw notImplemented('Conversion tracking integrity assessment is not configured for this deployment.')
    }
    const contract = toConversionTrackingContract(row)
    const googleAdsSnapshot = latestGoogleAdsSnapshot(app, project.id)
    const gtmSnapshot = latestGtmSnapshot(app, project.id)
    let assessment: ConversionTrackingIntegrityAssessmentDto
    try {
      assessment = conversionTrackingIntegrityAssessmentDtoSchema.parse(await opts.assessConversionTrackingIntegrity({
        project: asProjectRef(project), contract, googleAdsSnapshot, gtmSnapshot,
      }))
    } catch {
      throw providerError('Conversion tracking integrity assessment failed.')
    }
    if (assessment.contract.id !== contract.id || assessment.contract.projectId !== project.id) {
      throw providerError('Conversion tracking integrity assessment returned a mismatched contract.')
    }
    return {
      assessment,
      googleAdsSnapshot: googleAdsSnapshot?.metadata ?? null,
      gtmSnapshot: gtmSnapshot?.metadata ?? null,
    }
  })
}
