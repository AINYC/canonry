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
  cameraRatio: 1,
  containerProps: null as {
    graph?: { nodes: () => string[]; getNodeAttribute: (nodeKey: string, attribute: string) => string }
    settings?: {
      defaultNodeColor?: string
      defaultEdgeColor?: string
      defaultDrawNodeHover?: (...args: never[]) => void
      labelColor?: { color?: string }
    }
  } | null,
}))

const sigmaMockInstance = {
  setSetting: sigmaMocks.setSetting,
  refresh: sigmaMocks.refresh,
  getGraph: () => ({
    hasNode: () => true,
    areNeighbors: (left: string, right: string) => left === right || left === 'home' || right === 'home',
    extremities: () => ['home', 'pricing'],
  }),
  getCamera: () => ({ getState: () => ({ ratio: sigmaMocks.cameraRatio }) }),
}

vi.mock('@react-sigma/core', async () => {
  const React = await import('react')
  return {
    SigmaContainer: ({ children, graph, settings }: {
      children?: React.ReactNode
      graph?: { order: number; size: number; nodes: () => string[]; getNodeAttribute: (nodeKey: string, attribute: string) => string }
      settings?: {
        defaultNodeColor?: string
        defaultEdgeColor?: string
        defaultDrawNodeHover?: (...args: never[]) => void
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
    useSigma: () => sigmaMockInstance,
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
    fetchState: 'html',
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
    expect(within(screen.getAllByRole('option')[0]!).getByText('Indexable')).toBeTruthy()
    const legend = screen.getByLabelText('Site map legend')
    for (const marker of ['●', '◆', '×', '○']) {
      expect(within(legend).getByText(marker)).toBeTruthy()
    }

    fireEvent.change(search, { target: { value: 'page-77' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('page-77', expect.any(Object))
  })

  it('closes the search list on blur without breaking mouse or keyboard selection', async () => {
    mockWebGl(true)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await screen.findByTestId('sigma-container')
    const search = screen.getByRole('combobox', { name: 'Focus a page in the site map' })

    fireEvent.focus(search)
    expect(screen.getByRole('listbox', { name: 'Matching pages' })).not.toBeNull()
    fireEvent.blur(search)
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Matching pages' })).toBeNull())

    fireEvent.focus(search)
    const pricing = screen.getByRole('option', { name: /pricing/i })
    fireEvent.pointerDown(pricing)
    fireEvent.blur(search)
    fireEvent.click(pricing)
    expect(sigmaMocks.gotoNode).toHaveBeenCalledWith('pricing', expect.any(Object))
    expect(screen.queryByRole('listbox', { name: 'Matching pages' })).toBeNull()

    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(sigmaMocks.gotoNode).toHaveBeenCalled()
  })

  it('only passes Sigma 3 parseable non-black colors to the renderer', async () => {
    mockWebGl(true)
    render(
      <SiteGraphSigma
        nodes={[
          node('eligible'),
          node('hidden', { indexabilityState: 'noindex' }),
          node('failed', { fetchState: 'fetch-error' }),
          node('unchecked', { fetchState: 'discovered', indexabilityState: 'unknown' }),
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

  it('draws hovered labels with the theme contrast pair instead of Sigma white', async () => {
    mockWebGl(true)
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await waitFor(() => expect(sigmaMocks.containerProps).not.toBeNull())
    const drawHover = sigmaMocks.containerProps?.settings?.defaultDrawNodeHover
    expect(drawHover).toBeTypeOf('function')

    let currentFillStyle = ''
    const paintedFillStyles: string[] = []
    const textFillStyles: string[] = []
    const strokeStyles: string[] = []
    const context = {
      arc: vi.fn(),
      arcTo: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(() => paintedFillStyles.push(currentFillStyle)),
      fillText: vi.fn(() => textFillStyles.push(currentFillStyle)),
      font: '',
      lineTo: vi.fn(),
      lineWidth: 0,
      measureText: vi.fn(() => ({ width: 120 })),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
    }
    Object.defineProperty(context, 'fillStyle', {
      set: (color: string) => {
        currentFillStyle = color
      },
    })
    Object.defineProperty(context, 'strokeStyle', {
      set: (color: string) => strokeStyles.push(color),
    })

    drawHover!(
      context as never,
      { x: 40, y: 30, size: 10, label: '/pricing', color: '#56b4e9' } as never,
      {
        labelFont: 'Geist Sans, sans-serif',
        labelSize: 13,
        labelWeight: '600',
      } as never,
    )

    expect(paintedFillStyles.at(-1)).toBe('#18181b')
    expect(textFillStyles).toEqual(['#e4e4e7'])
    expect(paintedFillStyles).not.toContain('#FFF')
    expect(strokeStyles).toContain('#a1a1aa')
    expect(context.fillText).toHaveBeenCalledWith('/pricing', expect.any(Number), expect.any(Number))
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

  it('shows the page audit score in the graph tooltip without changing the graph encoding', async () => {
    mockWebGl(true)
    render(
      <SiteGraphSigma
        nodes={[node('home'), node('pricing', { auditScore: 61 })]}
        edges={edges}
      />,
    )

    await waitFor(() => expect(sigmaMocks.handlers.enterNode).toBeTypeOf('function'))
    act(() => {
      sigmaMocks.handlers.enterNode!({ node: 'pricing', event: { x: 100, y: 80 } } as never)
    })

    const tooltip = screen.getByRole('tooltip')
    expect(within(tooltip).getByText('Score 61/100')).not.toBeNull()
    expect(within(tooltip).getByText(/allowed to index this page/)).not.toBeNull()
  })

  it('reads the live camera ratio, so a fitted first paint is the overview', async () => {
    // The reducers used to close over a snapshot of the camera state that only
    // a camera EVENT could refresh. A fitted first paint fires no such event,
    // so a dense site opened showing every label and the whole edge mesh.
    mockWebGl(true)
    sigmaMocks.cameraRatio = 1
    render(<SiteGraphSigma nodes={nodes} edges={edges} />)

    await waitFor(() => expect(sigmaMocks.refresh).toHaveBeenCalled())
    const reducerFor = (name: string) => sigmaMocks.setSetting.mock.calls
      .filter(([setting]) => setting === name).at(-1)![1] as (key: string, attributes: never) => Record<string, unknown>
    const nodeReducer = reducerFor('nodeReducer')
    const edgeReducer = reducerFor('edgeReducer')
    const graph = sigmaMocks.containerProps!.graph!
    const edgeKey = 'home-pricing'

    // Fitted: no edge mesh, and the label budget is in force.
    expect(edgeReducer(edgeKey, {} as never).hidden).toBe(true)

    // Zooming in reveals edges through the SAME reducer instance, with no
    // camera event and no graph refresh in between.
    const refreshesBefore = sigmaMocks.refresh.mock.calls.length
    sigmaMocks.cameraRatio = 0.3
    expect(edgeReducer(edgeKey, {} as never).hidden).toBeUndefined()
    expect(sigmaMocks.refresh).toHaveBeenCalledTimes(refreshesBefore)

    sigmaMocks.cameraRatio = 1
    expect(edgeReducer(edgeKey, {} as never).hidden).toBe(true)
    expect(graph.nodes().length).toBeGreaterThan(0)
    expect(nodeReducer).toBeTypeOf('function')
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
    expect(screen.getByText('This scan has no map yet. Run a new scan to create one.')).toBeTruthy()

    rerender(<SiteGraphSigma nodes={[node('home', { x: Number.NaN })]} edges={[]} />)
    expect(screen.getByText('This scan has no map yet. Run a new scan to create one.')).toBeTruthy()
  })

  it('distinguishes a persisted layout failure from an older scan without a layout', () => {
    const { rerender } = render(
      <SiteGraphSigma nodes={nodes} edges={edges} layoutState="unavailable" layoutUnavailableReason="legacy-snapshot" />,
    )
    expect(screen.getByText('No map yet')).toBeTruthy()
    expect(screen.getByText('This scan has no map yet. Run a new scan to create one.')).toBeTruthy()

    rerender(
      <SiteGraphSigma nodes={nodes} edges={edges} layoutState="unavailable" layoutUnavailableReason="layout-failed" />,
    )
    expect(screen.getByText('Map could not be built')).toBeTruthy()
    expect(screen.getByText('The map could not be created for this scan. Run a new scan to try again.')).toBeTruthy()
  })
})
