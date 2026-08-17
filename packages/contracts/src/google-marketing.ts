import { z } from 'zod'
import {
  googleAdsRawSnapshotDtoSchema,
  googleAdsRawSnapshotMetadataDtoSchema,
} from './google-ads.js'
import {
  gtmRawSnapshotDtoSchema,
  gtmRawSnapshotMetadataDtoSchema,
} from './google-tag-manager.js'
import { conversionTrackingIntegrityAssessmentDtoSchema } from './conversion-tracking.js'

const opaqueIdSchema = z.string().trim().min(1)

/** Canonical Google Ads customer ID: ten digits, without display hyphens. */
export function canonicalizeGoogleAdsCustomerId(value: string): string | null {
  const trimmed = value.trim()
  if (/^\d{10}$/.test(trimmed)) return trimmed
  if (/^\d{3}-\d{3}-\d{4}$/.test(trimmed)) return trimmed.replaceAll('-', '')
  return null
}

// GTM resource IDs are inserted into provider URL path segments. Keep the
// accepted bare form deliberately narrower than "any string without a slash":
// dot segments, query/fragment delimiters, percent escapes, and backslashes
// can all change a URL after its path is normalized.
const safeGtmIdPattern = /^[\w-]+$/

function bareGtmId(value: string): string | null {
  const trimmed = value.trim()
  return safeGtmIdPattern.test(trimmed) ? trimmed : null
}

/** Accept a bare GTM account ID or its exact `accounts/{id}` resource path. */
export function canonicalizeGtmAccountId(value: string): string | null {
  const trimmed = value.trim()
  const resource = /^accounts\/([\w-]+)$/.exec(trimmed)
  return resource?.[1] ?? bareGtmId(trimmed)
}

/** Accept a bare container ID or a resource path owned by `accountId`. */
export function canonicalizeGtmContainerId(value: string, accountId: string): string | null {
  const trimmed = value.trim()
  const resource = /^accounts\/([\w-]+)\/containers\/([\w-]+)$/.exec(trimmed)
  if (resource) return resource[1] === accountId ? resource[2]! : null
  return bareGtmId(trimmed)
}

/** Accept a bare workspace ID or a resource path owned by the selected container. */
export function canonicalizeGtmWorkspaceId(
  value: string,
  accountId: string,
  containerId: string,
): string | null {
  const trimmed = value.trim()
  const resource = /^accounts\/([\w-]+)\/containers\/([\w-]+)\/workspaces\/([\w-]+)$/.exec(trimmed)
  if (resource) {
    return resource[1] === accountId && resource[2] === containerId ? resource[3]! : null
  }
  return bareGtmId(trimmed)
}

export function canonicalizeGoogleAdsCustomerSelection(input: {
  loginCustomerId?: string | null
  customerId: string
}): { loginCustomerId?: string | null; customerId: string } | null {
  const customerId = canonicalizeGoogleAdsCustomerId(input.customerId)
  if (!customerId) return null
  if (input.loginCustomerId === null) return { loginCustomerId: null, customerId }
  if (input.loginCustomerId === undefined) return { customerId }
  const loginCustomerId = canonicalizeGoogleAdsCustomerId(input.loginCustomerId)
  return loginCustomerId ? { loginCustomerId, customerId } : null
}

export function canonicalizeGtmResourceSelection(input: {
  accountId: string
  containerId: string
  workspaceId?: string
}): { accountId: string; containerId: string; workspaceId?: string } | null {
  const accountId = canonicalizeGtmAccountId(input.accountId)
  if (!accountId) return null
  const containerId = canonicalizeGtmContainerId(input.containerId, accountId)
  if (!containerId) return null
  if (input.workspaceId === undefined) return { accountId, containerId }
  const workspaceId = canonicalizeGtmWorkspaceId(input.workspaceId, accountId, containerId)
  return workspaceId ? { accountId, containerId, workspaceId } : null
}

export const googleMarketingProviderSchema = z.enum(['google-ads', 'gtm'])
export type GoogleMarketingProvider = z.infer<typeof googleMarketingProviderSchema>
export const GoogleMarketingProviders = googleMarketingProviderSchema.enum

/**
 * Starts a private OAuth flow. `developerToken` is accepted only for the
 * Google Ads authorization setup and is intentionally absent from every
 * response/persistence DTO.
 */
export const googleMarketingOAuthConnectRequestSchema = z.object({
  provider: googleMarketingProviderSchema,
  publicUrl: z.string().url().optional(),
  developerToken: z.string().trim().min(1).max(512).optional(),
}).strict()
export type GoogleMarketingOAuthConnectRequest = z.infer<typeof googleMarketingOAuthConnectRequestSchema>

/** Safe browser hand-off only; no OAuth access/refresh token or developer token is echoed. */
export const googleMarketingOAuthConnectResponseSchema = z.object({
  provider: googleMarketingProviderSchema,
  authorizationUrl: z.string().url(),
  redirectUri: z.string().url(),
  expiresAt: z.string().nullable(),
}).strict()
export type GoogleMarketingOAuthConnectResponse = z.infer<typeof googleMarketingOAuthConnectResponseSchema>

export const googleAdsCustomerSelectionRequestSchema = z.object({
  /** Optional manager account used for the Google Ads API's login-customer header. */
  loginCustomerId: opaqueIdSchema.nullable().optional(),
  customerId: opaqueIdSchema,
}).strict().superRefine((selection, context) => {
  if (!canonicalizeGoogleAdsCustomerSelection(selection)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected ten-digit Google Ads customer IDs, with optional 3-3-4 display hyphens.',
    })
  }
})
export type GoogleAdsCustomerSelectionRequest = z.infer<typeof googleAdsCustomerSelectionRequestSchema>

export const gtmResourceSelectionRequestSchema = z.object({
  accountId: opaqueIdSchema,
  containerId: opaqueIdSchema,
  /** Optional on an account/container selection; required later to inspect one draft. */
  workspaceId: opaqueIdSchema.optional(),
}).strict().superRefine((selection, context) => {
  if (!canonicalizeGtmResourceSelection(selection)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GTM resource paths must match the selected account and container.',
    })
  }
})
export type GtmResourceSelectionRequest = z.infer<typeof gtmResourceSelectionRequestSchema>

export const googleMarketingDisconnectResponseSchema = z.object({
  provider: googleMarketingProviderSchema,
  disconnected: z.boolean(),
}).strict()
export type GoogleMarketingDisconnectResponse = z.infer<typeof googleMarketingDisconnectResponseSchema>

/** Metadata-first paging keeps normal snapshot list reads bounded. */
export const GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX = 100

export const googleAdsStoredSnapshotPageSchema = z.object({
  snapshots: z.array(googleAdsRawSnapshotMetadataDtoSchema).max(GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
}).strict()
export type GoogleAdsStoredSnapshotPage = z.infer<typeof googleAdsStoredSnapshotPageSchema>

export const googleAdsStoredSnapshotReadEnvelopeSchema = z.object({
  snapshot: googleAdsRawSnapshotDtoSchema,
}).strict()
export type GoogleAdsStoredSnapshotReadEnvelope = z.infer<typeof googleAdsStoredSnapshotReadEnvelopeSchema>

export const gtmStoredSnapshotPageSchema = z.object({
  snapshots: z.array(gtmRawSnapshotMetadataDtoSchema).max(GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
}).strict()
export type GtmStoredSnapshotPage = z.infer<typeof gtmStoredSnapshotPageSchema>

export const gtmStoredSnapshotReadEnvelopeSchema = z.object({
  snapshot: gtmRawSnapshotDtoSchema,
}).strict()
export type GtmStoredSnapshotReadEnvelope = z.infer<typeof gtmStoredSnapshotReadEnvelopeSchema>

/** One integrity answer with the exact stored observations that informed it. */
export const conversionTrackingIntegrityReadEnvelopeSchema = z.object({
  assessment: conversionTrackingIntegrityAssessmentDtoSchema,
  googleAdsSnapshot: googleAdsRawSnapshotMetadataDtoSchema.nullable(),
  gtmSnapshot: gtmRawSnapshotMetadataDtoSchema.nullable(),
}).strict()
export type ConversionTrackingIntegrityReadEnvelope = z.infer<typeof conversionTrackingIntegrityReadEnvelopeSchema>
