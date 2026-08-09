import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { parseColor } from 'sigma/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sigmaMocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: never[]) => void>,
  setSetting: vi.fn(),
  refresh: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  reset: vi.fn(),
  gotoNode: vi.fn(),
  shouldThrow: false,
  containerProps: null as {
    graph?: { nodes: () => string[]; getNodeAttribute: (nodeKey: string, attribute: string) => string }
    settings?: {
      defaultNodeColor?: string
      defaultEdgeColor?: string
      labelColor?: { color?: string }
    }
  } | null,
}))

vi.mock('@react-sigma/core', async () => {
  const React = await import('react')
  return {
    SigmaContainer: ({ children, graph, settings }: {
      children?: React.ReactNode
      graph?: { order: number; size: number; nodes: () => string[]; getNodeAttribute: (nodeKey: string, attribute: string) => string }
      settings?: {
        defaultNodeColor?: string
        defaultEdgeColor?: string
        labelColor?: { color?: string }
      }
    }) => {
      if (sigmaMocks.shouldThrow) throw new Error('WebGL renderer failed')
      sigmaMocks.containerProps = { graph, settings }
      return React.createElement(
        'div',
        {
          'data-testid': 'sigma-container',
          'data-nodes': graph?.order,
          'data-edges': graph?.size,
        },
        children,
      )
    },
    useCamera: () => ({
      zoomIn: sigmaMocks.zoomIn,
      zoomOut: sigmaMocks.zoomOut,
      reset: sigmaMocks.reset,
      gotoNode: sigmaMocks.gotoNode,
    }),
    useRegisterEvents: () => (handlers: Record<string, (...args: never[]) => void>) => {
      sigmaMocks.handlers = handlers
    },
    useSigma: () => ({
      setSetting: sigmaMocks.setSetting,
      refresh: sigmaMocks.refresh,
      getGraph: () => ({
        hasNode: () => true,
        areNeighbors: (left: string, right: string) => left === right || left === 'home' || right === 'home',
        extremities: () => ['home', 'pricing'],
      }),
      getCamera: () => ({ getState: () => ({ ratio: 1 }) }),
    }),
  }
})

import {
  SiteGraphSigma,
  type SiteGraphSigmaNode,
} from '../src/components/project/SiteGraphSigma.js'

function node(
  nodeKey: string,
  overrides: Partial<SiteGraphSigmaNode> = {},
): SiteGraphSigmaNode {
  return {
    nodeKey,
    url: `https://example.com/${nodeKey}`,
    path: nodeKey === 'home' ? '/' : `/${nodeKey}`,
    depth: nodeKey === 'home' ? 0 : 1,
    indexabilityState: 'indexable',
    fetchState: 'fetched',
    linkScoreNormalized: 0.5,
    x: nodeKey === 'home' ? 0 : 100,
    y: 0,
    ...overrides,
  }
}

const nodes = [node('home'), node('pricing')]
const edges = [{
  edgeKey: 'home-pricing',
  sourceNodeKey: 'home',
  targetNodeKey: 'pricing',
  followable: true,
  occurrences: 1,
}]

function mockWebGl(supported: boolean) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((contextId: string) => {
    if (contextId === 'webgl' || contextId === 'webgl2') return supported ? {} : null
    return null
  }) as typeof HTMLCanvasElement.prototype.getContext)
}

beforeEach(() => {
  sigmaMocks.handlers = {}
  sigmaMocks.shouldThrow = false
  sigmaMocks.containerProps = null
  sigmaMocks.setSetting.mockReset()
  sigmaMocks.refresh.mockReset()
  sigmaMocks.zoomIn.mockReset()
  sigmaMocks.zoomOut.mockReset()
  sigmaMocks.reset.mockReset()
  sigmaMocks.gotoNode.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SiteGraphSigma', () => {
  it('is import-safe for server rendering and keeps WebGL out of the accessibility tree', () => {
    expect(() => renderToString(
      <SiteGraphSigma nodes={nodes} edges={edges} ariaLabel="Website link graph" />,
    )).not.toThrow()

    const markup = renderToString(
      <SiteGraphSigma nodes={nodes} edges={edges} ariaLabel="Website link graph" />,
    )
    expect(markup).toContain('Website link graph')
    expect(markup).toContain('Preparing the interactive site map')
  })

  it('loads the positioned graph and exposes bounded keyboard page search', async () => {
    mockWebGl(true)
    const manyNodes = Array.from({ length: 80 }, (_, index) => node(`page-${String(index).padStart(2, '0')}`, { x: index }))

    render(<SiteGraphSigma nodes={manyNodes} edges={[]} />)

    await screen.findByTestId('sigma-container')
    const search = screen.getByRole('combobox', { name: 'Focus a page in the site map' })
    fireEvent.focus(search)
    expect(screen.getAllByRole('option')).toHaveLength(50)
    expect(within(screen.getAllByRole('option')[0]!).getByText('Technically eligible')).toBeTruthy()
    const legend = screen.getByLabelText('Site map legend')
    for (const marker of ['●', '◆', '×', '○']) {
      expect(within(legend).getByText(marker)).toBeTruthy()
    }

    fireEvent.change(search, { target: { value: 'page-77' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('page-77', expect.any(Object))
  })

  it('only passes Sigma 3 parseable non-black colors to the renderer', async () => {
    mockWebGl(true)
    render(
      <SiteGraphSigma
        nodes={[
          node('eligible'),
          node('hidden', { indexabilityState: 'noindex' }),
          node('failed', { fetchState: 'fetch-error' }),
          node('unchecked', { fetchState: 'not-fetched' }),
        ]}
        edges={[]}
      />,
    )

    await waitFor(() => expect(sigmaMocks.containerProps).not.toBeNull())
    const { graph, settings } = sigmaMocks.containerProps!
    const colors = [
      settings?.defaultNodeColor,
      settings?.defaultEdgeColor,
      settings?.labelColor?.color,
      ...(graph?.nodes().map((nodeKey) => graph.getNodeAttribute(nodeKey, 'color')) ?? []),
    ]

    for (const color of colors) {
      expect(color).toBeTruthy()
      const parsed = parseColor(color!)
      expect([parsed.r, parsed.g, parsed.b], color).not.toEqual([0, 0, 0])
    }
  })

  it('selects a node from Sigma events and reports it to the parent', async () => {
    mockWebGl(true)
    const onSelectNode = vi.fn()
    render(<SiteGraphSigma nodes={nodes} edges={edges} onSelectNode={onSelectNode} />)

    await waitFor(() => expect(sigmaMocks.handlers.clickNode).toBeTypeOf('function'))
    act(() => {
      sigmaMocks.handlers.clickNode!({ node: 'pricing', event: { x: 100, y: 80 } } as never)
    })

    expect(onSelectNode).toHaveBeenCalledWith(expect.objectContaining({ nodeKey: 'pricing' }))
  })

  it('only refreshes the graph when camera zoom crosses the overview threshold', async () => {
    mockWebGl(true)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await waitFor(() => expect(sigmaMocks.handlers.updated).toBeTypeOf('function'))
    const initialRefreshes = sigmaMocks.refresh.mock.calls.length

    act(() => {
      for (const ratio of [1.01, 1.1, 1.2, 1.34, 1.01]) {
        sigmaMocks.handlers.updated!({ ratio } as never)
      }
    })
    expect(sigmaMocks.refresh).toHaveBeenCalledTimes(initialRefreshes)

    act(() => sigmaMocks.handlers.updated!({ ratio: 0.7 } as never))
    await waitFor(() => expect(sigmaMocks.refresh).toHaveBeenCalledTimes(initialRefreshes + 1))

    act(() => {
      for (const ratio of [0.6, 0.5, 0.7]) {
        sigmaMocks.handlers.updated!({ ratio } as never)
      }
    })
    expect(sigmaMocks.refresh).toHaveBeenCalledTimes(initialRefreshes + 1)
  })

  it('does not reconfigure a renderer while its container is being destroyed', async () => {
    mockWebGl(true)
    const rendered = render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await waitFor(() => expect(sigmaMocks.setSetting).toHaveBeenCalled())
    sigmaMocks.setSetting.mockClear()
    rendered.unmount()

    expect(sigmaMocks.setSetting).not.toHaveBeenCalled()
  })

  it('moves the camera when controlled selection changes outside the graph', async () => {
    mockWebGl(true)
    const { rerender } = render(
      <SiteGraphSigma nodes={nodes} edges={edges} selectedNodeKey="home" />,
    )

    await waitFor(() => expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('home', expect.any(Object)))
    sigmaMocks.gotoNode.mockClear()
    rerender(<SiteGraphSigma nodes={nodes} edges={edges} selectedNodeKey="pricing" />)

    await waitFor(() => expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('pricing', expect.any(Object)))
  })

  it('shows a truthful fallback when WebGL is unavailable', async () => {
    mockWebGl(false)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    expect(await screen.findByText('Interactive map unavailable')).toBeTruthy()
    expect(screen.getByText(/page inventory remains available/i)).toBeTruthy()
  })

  it('contains renderer failures without taking down Site Health', async () => {
    mockWebGl(true)
    sigmaMocks.shouldThrow = true
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    expect(await screen.findByText('Interactive map unavailable')).toBeTruthy()
  })

  it('distinguishes an empty graph from missing server layout positions', () => {
    const { rerender } = render(<SiteGraphSigma nodes={[]} edges={[]} />)
    expect(screen.getByText('No page graph is available for this scan.')).toBeTruthy()

    rerender(<SiteGraphSigma nodes={[]} edges={[]} layoutState="unavailable" />)
    expect(screen.getByText('This scan does not have a published graph layout yet.')).toBeTruthy()

    rerender(<SiteGraphSigma nodes={[node('home', { x: Number.NaN })]} edges={[]} />)
    expect(screen.getByText('This scan does not have a published graph layout yet.')).toBeTruthy()
  })
})
