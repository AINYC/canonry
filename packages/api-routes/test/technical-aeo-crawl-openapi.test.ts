import { expect, test } from 'vitest'
import { buildOpenApiDocument } from '../src/openapi.js'

test('crawl read routes are public, bounded, and backed by typed OpenAPI schemas', () => {
  const document = buildOpenApiDocument()
  const paths = document.paths ?? {}
  const cases: Array<[string, string]> = [
    ['/api/v1/projects/{name}/technical-aeo/crawl', 'SiteCrawlSummaryDto'],
    ['/api/v1/projects/{name}/technical-aeo/graph', 'SiteCrawlGraphResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/subgraph', 'SiteHealthSubgraphResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/path', 'SiteHealthPathResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/changes', 'SiteHealthChangesResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/crawl/pages', 'SiteCrawlPagesResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/structure', 'SiteCrawlStructureResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/internal-links', 'SiteCrawlInternalLinksResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/internal-links/neighbors', 'SiteCrawlNeighborsResponseDto'],
    ['/api/v1/projects/{name}/technical-aeo/dead-links', 'SiteCrawlDeadLinksResponseDto'],
  ]

  for (const [path, schema] of cases) {
    const operation = paths[path]?.get
    expect(operation, `${path} must be documented`).toBeDefined()
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe(`#/components/schemas/${schema}`)
  }

  const pages = paths['/api/v1/projects/{name}/technical-aeo/crawl/pages']!.get!
  expect(pages.parameters?.some((parameter) => parameter.name === 'cursor')).toBe(true)
  expect(pages.parameters?.some((parameter) => parameter.name === 'limit')).toBe(true)
  expect(paths['/api/v1/projects/{name}/technical-aeo/dead-links']!.get?.description).toMatch(/discriminated/i)

  const graph = paths['/api/v1/projects/{name}/technical-aeo/graph']!.get!
  expect(graph.parameters?.find((parameter) => parameter.name === 'maxNodes')?.schema).toMatchObject({ minimum: 1, maximum: 20_000 })
  expect(graph.parameters?.find((parameter) => parameter.name === 'maxEdges')?.schema).toMatchObject({ minimum: 1, maximum: 50_000 })

  const subgraph = paths['/api/v1/projects/{name}/technical-aeo/subgraph']!.get!
  expect(subgraph.parameters?.find((parameter) => parameter.name === 'hops')?.schema).toMatchObject({ minimum: 0, maximum: 3 })
  expect(subgraph.parameters?.find((parameter) => parameter.name === 'maxNodes')?.schema).toMatchObject({ minimum: 1, maximum: 200 })
  expect(subgraph.parameters?.find((parameter) => parameter.name === 'maxEdges')?.schema).toMatchObject({ minimum: 1, maximum: 500 })

  const path = paths['/api/v1/projects/{name}/technical-aeo/path']!.get!
  expect(path.parameters?.find((parameter) => parameter.name === 'maxDepth')?.schema).toMatchObject({ minimum: 1, maximum: 24 })

  const changes = paths['/api/v1/projects/{name}/technical-aeo/changes']!.get!
  expect(changes.parameters?.find((parameter) => parameter.name === 'limit')?.schema).toMatchObject({ minimum: 1, maximum: 100 })
  expect(changes.parameters?.some((parameter) => parameter.name === 'cursor')).toBe(true)
})

test('crawl summary nullability and run budgets are machine-readable in OpenAPI', () => {
  const document = buildOpenApiDocument()
  const paths = document.paths ?? {}
  const summary = document.components?.schemas?.SiteCrawlSummaryDto as {
    properties?: Record<string, unknown>
  }
  const runStatus = summary.properties?.runStatus as { anyOf?: Array<{ enum?: unknown[] }> }

  // `runStatus` is null when there is no persisted crawl. Use an explicit
  // union because client generators do not consistently honor OAS 3.0
  // `nullable` alongside an enum.
  expect(runStatus.anyOf).toEqual(expect.arrayContaining([
    expect.objectContaining({ enum: expect.arrayContaining([null]) }),
  ]))

  const run = paths['/api/v1/projects/{name}/technical-aeo/runs']!.post!
  const properties = run.requestBody?.content?.['application/json']?.schema?.properties as Record<string, {
    minimum?: number
    maximum?: number
  }>
  expect(properties.limit).toMatchObject({ minimum: 1, maximum: 2_000 })
  expect(properties.maxPages).toMatchObject({ minimum: 1, maximum: 50_000 })
  expect(properties.maxEdges).toMatchObject({ minimum: 1, maximum: 1_000_000 })
  expect(properties.maxDepth).toMatchObject({ minimum: 0, maximum: 100 })
  expect(run.responses?.['409']).toBeDefined()
  expect(run.description).toMatch(/reused only when.*match exactly/i)
  expect(paths['/api/v1/projects/{name}/technical-aeo/crawl']!.get?.description).toMatch(/latest complete/i)
})
