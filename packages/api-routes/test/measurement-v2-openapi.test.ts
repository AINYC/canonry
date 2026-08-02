import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

interface SpecOperation {
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>
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
    const overview = document.paths['/api/v1/projects/{name}/measurement-overview']?.get
    const runId = overview?.parameters?.find(parameter => parameter.name === 'runId')

    expect(runId).toMatchObject({ in: 'query' })
    expect(overview?.responses?.['422']).toBeDefined()
    expect(overview?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementOverviewResponse')
  })
})
