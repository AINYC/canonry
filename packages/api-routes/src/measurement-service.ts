import type { FastifyInstance } from 'fastify'
import {
  deliveryFailed,
  effectiveDomains,
  measurementDiscoveryRequestSchema,
  measurementDiscoveryResponseSchema,
  measurementReportResponseSchema,
  notFound,
  validationError,
} from '@ainyc/canonry-contracts'
import { requireScope } from './auth.js'
import {
  classifyMeasurementSitemapUrls,
  MeasurementDiscoveryConfigurationError,
} from './measurement-discovery.js'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'
import { buildStoredMeasurementReport } from './measurement-report-adapter.js'
import {
  fetchMeasurementSitemap,
  type MeasurementSitemapFetchResult,
} from './measurement-sitemap-fetch.js'
import { resolveProject } from './helpers.js'

const DEFAULT_DISCOVERY_URL_LIMIT = 10_000

export interface MeasurementServiceRoutesOptions {
  fetchSitemap?: (sitemapUrl: string) => Promise<MeasurementSitemapFetchResult>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Network and persistence adapters around the pure Target discovery/report kernels. */
export async function measurementServiceRoutes(app: FastifyInstance, opts: MeasurementServiceRoutesOptions) {
  app.post<{ Params: { name: string } }>('/projects/:name/measurement-discovery', async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const parsed = measurementDiscoveryRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid measurement discovery request', { issues: parsed.error.issues })
    }

    let fetched: MeasurementSitemapFetchResult
    try {
      fetched = await (opts.fetchSitemap ?? fetchMeasurementSitemap)(parsed.data.sitemapUrl)
    } catch (error) {
      throw deliveryFailed(`Unable to fetch sitemap: ${messageOf(error)}`)
    }

    try {
      return measurementDiscoveryResponseSchema.parse(classifyMeasurementSitemapUrls({
        ownedHosts: effectiveDomains(project),
        rules: parsed.data.rule,
        urls: fetched.urls,
        maxUrls: parsed.data.maxUrls ?? DEFAULT_DISCOVERY_URL_LIMIT,
      }))
    } catch (error) {
      if (error instanceof MeasurementDiscoveryConfigurationError) {
        throw validationError(error.message)
      }
      throw error
    }
  })

  app.get<{ Params: { name: string }; Querystring: { revision?: string } }>('/projects/:name/measurement-report', async request => {
    const project = resolveProject(app.db, request.params.name)
    const rawRevision = request.query.revision
    if (typeof rawRevision !== 'string' || !/^[1-9]\d*$/.test(rawRevision)) {
      throw validationError('"revision" must be a positive integer')
    }
    const revision = Number(rawRevision)
    if (!Number.isSafeInteger(revision)) throw validationError('"revision" must be a positive safe integer')

    const result = buildStoredMeasurementReport(app.db, project.id, revision)
    if (result.kind === 'no-plan') throw notFound('Measurement plan revision', rawRevision)
    return measurementReportResponseSchema.parse(result.report)
  })
}
