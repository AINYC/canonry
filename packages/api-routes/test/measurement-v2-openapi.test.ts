import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

interface SpecParameter {
  name?: string
  in?: string
  required?: boolean
  description?: string
  schema?: { type?: string; enum?: string[]; default?: string }
}

interface SpecOperation {
  description?: string
  parameters?: SpecParameter[]
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> }
  responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
}

interface Spec {
  components?: { schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> }
  paths: Record<string, Record<string, SpecOperation>>
}

const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
})

async function spec(): Promise<Spec> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-v2-spec-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
  cleanups.push(() => void app.close())

  const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
  expect(response.statusCode).toBe(200)
  return response.json() as Spec
}

const DRAFT = '/api/v1/projects/{name}/measurement-plan/draft'
const OVERVIEW = '/api/v1/projects/{name}/measurement-overview'
const OVERVIEW_SORTS = [
  'label-asc',
  'label-desc',
  'citationCoverage-asc',
  'citationCoverage-desc',
  'mentionCoverage-asc',
  'mentionCoverage-desc',
]

describe('advanced measurement v2 openapi surface', () => {
  it('types every draft action against a contract, not a loose object', async () => {
    const document = await spec()
    const cases: Array<[string, string]> = [
      ['create', 'MeasurementDraftCreateRequest'],
      ['import-sitemap', 'MeasurementDraftImportSitemapRequest'],
      ['apply-sitemap-selection', 'MeasurementDraftApplySitemapSelectionRequest'],
      ['upsert-target', 'MeasurementDraftUpsertTargetRequest'],
      ['rename-target', 'MeasurementDraftRenameTargetRequest'],
      ['merge-targets', 'MeasurementDraftMergeTargetsRequest'],
      ['exclude-target', 'MeasurementDraftExcludeTargetRequest'],
      ['rebind-target', 'MeasurementDraftRebindTargetRequest'],
      ['apply-assignments', 'MeasurementDraftApplyAssignmentsRequest'],
      ['remove-assignment', 'MeasurementDraftRemoveAssignmentRequest'],
      ['clear-assignments', 'MeasurementDraftClearAssignmentsRequest'],
      ['classify-assignments', 'MeasurementDraftClassifyAssignmentsRequest'],
      ['upsert-group', 'MeasurementDraftUpsertGroupRequest'],
      ['remove-group', 'MeasurementDraftRemoveGroupRequest'],
      ['upsert-competitor', 'MeasurementDraftUpsertCompetitorRequest'],
      ['remove-competitor', 'MeasurementDraftRemoveCompetitorRequest'],
      ['publish', 'MeasurementDraftPublishRequest'],
    ]
    for (const [action, schemaName] of cases) {
      const operation = document.paths[`${DRAFT}/actions/${action}`]?.post
      expect(operation, `${action} is not documented`).toBeDefined()
      expect(
        operation!.requestBody?.content?.['application/json']?.schema?.$ref,
        `${action} request body`,
      ).toBe(`#/components/schemas/${schemaName}`)
    }
  })

  it('demands the ETag and idempotency guards on a mutation but not on a preview', async () => {
    const document = await spec()
    const headers = (action: string) => (document.paths[`${DRAFT}/actions/${action}`]?.post?.parameters ?? [])
      .filter(parameter => parameter.in === 'header')
      .map(parameter => `${parameter.name}:${parameter.required === true}`)
      .sort()

    expect(headers('publish')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    expect(headers('upsert-target')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    // Compiling the stored draft writes nothing, so it carries neither guard.
    expect(headers('compile-preview')).toEqual([])
    expect(headers('diff-preview')).toEqual([])
  })

  it('documents draft creation as idempotency-only while ordinary mutations require the draft ETag', async () => {
    const document = await spec()
    const operation = (action: string) => document.paths[`${DRAFT}/actions/${action}`]?.post
    const headers = (action: string) => (operation(action)?.parameters ?? [])
      .filter(parameter => parameter.in === 'header')
      .map(parameter => `${parameter.name}:${parameter.required === true}`)
      .sort()
    const errorStatuses = (action: string) => Object.keys(operation(action)?.responses ?? {})
      .filter(status => Number(status) >= 400)
      .sort()

    expect.soft(headers('create')).toEqual(['Idempotency-Key:true'])
    expect.soft(errorStatuses('create')).toEqual(['400', '403', '404', '409'])

    expect.soft(headers('upsert-target')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    expect.soft(errorStatuses('upsert-target')).toEqual(['400', '403', '404', '409', '412', '428'])
  })

  it('publishes the compiled checksum on every contract that reviews or guards content', async () => {
    const document = await spec()
    const compile = document.components?.schemas?.MeasurementDraftCompilePreviewResponse
    const publishRequest = document.components?.schemas?.MeasurementDraftPublishRequest
    const publishResponse = document.components?.schemas?.MeasurementPlanV2PublishResponse

    expect(JSON.stringify(compile)).toContain('compiledChecksum')
    expect(publishRequest?.required).toEqual(
      expect.arrayContaining(['expectedActiveRevision', 'expectedCompiledChecksum']),
    )
    expect(JSON.stringify(publishResponse)).toContain('compiledChecksum')
  })

  it('emits brandPresence and documents sov as its deprecated alias', async () => {
    const document = await spec()
    const overview = document.components?.schemas?.MeasurementOverviewResponse
    const metrics = overview?.properties?.metrics as {
      required?: string[]
      properties?: Record<string, { description?: string }>
    } | undefined

    expect(metrics?.required).toEqual(expect.arrayContaining(['brandPresence', 'sov']))
    expect(metrics?.properties?.sov?.description).toMatch(/deprecated/i)
  })

  it('documents the cross-revision run rejection on the overview', async () => {
    const document = await spec()
    const overview = document.paths[OVERVIEW]?.get
    const runId = overview?.parameters?.find(parameter => parameter.name === 'runId')

    expect(runId).toMatchObject({ in: 'query' })
    expect(overview?.responses?.['422']).toBeDefined()
    expect(overview?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementOverviewResponse')
  })

  it('exposes sort-aware snapshot ranking without implying a trend', async () => {
    const document = await spec()
    const overview = document.paths[OVERVIEW]?.get
    const sort = overview?.parameters?.find(parameter => parameter.name === 'sort')
    const cursor = overview?.parameters?.find(parameter => parameter.name === 'cursor')

    expect(sort).toMatchObject({
      in: 'query',
      schema: { type: 'string', enum: OVERVIEW_SORTS, default: 'label-asc' },
    })
    expect(sort?.description).toMatch(/unavailable rows form the first bucket/i)
    expect(overview?.description).toMatch(/one revision-pinned run snapshot/i)
    expect(overview?.description).toMatch(/never infers a trend/i)
    expect(overview?.description).toMatch(/across revisions/i)
    expect(cursor?.description).toMatch(/sort-aware/i)
    expect(cursor?.description).toMatch(/pins pagination to.*run/i)
    expect(cursor?.description).toMatch(/same filters/i)
    expect(cursor?.description).toMatch(/legacy label cursor works only when sort is omitted/i)
  })
})
