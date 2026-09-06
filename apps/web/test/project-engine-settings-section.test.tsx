import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import type { EngineConnectionPublicDto } from '@ainyc/canonry-api-client'

import { ProjectEngineSettingsSection } from '../src/components/project/ProjectEngineSettingsSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { mockFetch, jsonResponse, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const settings = {
  providers: [{ name: 'gemini', displayName: 'Gemini', configured: true }, { name: 'openai', displayName: 'OpenAI', configured: false }],
  providerCatalog: [
    { name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [{ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' }], modelValidationPattern: { source: '^gemini-', flags: '' }, modelValidationHint: 'Use a Gemini model ID.' },
    { name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser', modelConfigurable: false, defaultModel: 'chatgpt-web', knownModels: [], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Detected from browser.' },
  ],
  engineConnections: [
    { id: 'gateway:research', label: 'Research gateway', preset: 'custom-openai-compatible' as const, protocol: 'openai-compatible' as const, baseUrl: 'https://research.example/v1', quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 }, secretConfigured: true },
  ],
  engineRoutes: [
    {
      id: 'native:gemini', label: 'Gemini', connectionId: 'native:gemini', modelId: 'gemini-2.5-flash', revision: 1, source: 'implicit-native' as const,
      capabilities: { kind: 'verified-measurement' as const, retrieval: true, citations: true, location: true, servedModel: true, fallback: 'disabled' as const },
    },
    {
      id: 'route:research-gateway', label: 'Research gateway', connectionId: 'gateway:research', modelId: 'research/model', revision: 1, source: 'configured' as const,
      capabilities: { kind: 'text-only' as const },
    },
  ],
  google: { configured: false }, bing: { configured: false },
}

function renderSection(
  onSave = vi.fn().mockResolvedValue(undefined),
  project = { name: 'demo', providers: [] as string[], providerModels: {} as Record<string, string> },
  settingsBody: Omit<typeof settings, 'engineConnections'> & { engineConnections: EngineConnectionPublicDto[] } = settings,
) {
  const restore = mockFetch(url => {
    if (url.split('?')[0]!.endsWith('/settings')) return jsonResponse(settingsBody)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProjectEngineSettingsSection project={project} onSave={onSave} /></QueryClientProvider>)
  return onSave
}

test('automatic providers serialize as an empty list and choose mode materializes configured native engines', async () => {
  const onSave = renderSection()
  await screen.findByText('All configured native engines')
  expect((screen.getByLabelText('All configured native engines') as HTMLInputElement).checked).toBe(true)
  act(() => { fireEvent.click(screen.getByLabelText('Choose engines')) })
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini'], providerModels: {} }))
})

test('project navigation cannot carry an unsaved research or model draft into another project', async () => {
  const restore = mockFetch(() => jsonResponse(settings))
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSave = vi.fn().mockResolvedValue(undefined)
  const renderProject = (name: string) => (
    <QueryClientProvider client={client}>
      <ProjectEngineSettingsSection project={{ name, providers: ['gemini'], providerModels: {}, researchProvider: null }} onSave={onSave} />
    </QueryClientProvider>
  )
  const view = render(renderProject('first'))
  await screen.findByLabelText('Research route')
  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'route:research-gateway' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemini-2.5-pro' } })
  view.rerender(renderProject('second'))
  await waitFor(() => expect((screen.getByLabelText('Research route') as HTMLSelectElement).value).toBe(''))
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('__inherit__')
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini'], providerModels: {} }))
})

test('research selection stays disabled until the settings save settles', async () => {
  let finish: (() => void) | undefined
  const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  renderSection(onSave)
  await screen.findByLabelText('Research route')
  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'route:research-gateway' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  expect((screen.getByLabelText('Research route') as HTMLSelectElement).disabled).toBe(true)
  await act(async () => { finish?.() })
  expect((screen.getByLabelText('Research route') as HTMLSelectElement).disabled).toBe(false)
})

test('inherit deletes only the selected provider override and custom models remain editable', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: { gemini: 'gemini-custom' } })
  await screen.findByLabelText('Gemini custom model ID')
  const input = screen.getByLabelText('Gemini custom model ID') as HTMLInputElement
  act(() => { fireEvent.change(input, { target: { value: 'gemini-next' } }) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ providers: ['gemini'], providerModels: { gemini: 'gemini-next' } }))
  const select = screen.getByLabelText('Model')
  act(() => { fireEvent.change(select, { target: { value: '__inherit__' } }) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ providers: ['gemini'], providerModels: {} }))
})

test('choosing Custom for a known-model override enters custom mode with an empty draft', async () => {
  renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro' } })
  const select = await screen.findByLabelText('Model') as HTMLSelectElement
  // A known override shows the catalog model, not the custom input.
  expect(select.value).toBe('gemini-2.5-pro')
  expect(screen.queryByLabelText('Gemini custom model ID')).toBeNull()
  act(() => { fireEvent.change(select, { target: { value: '__custom__' } }) })
  // Switching to custom must actually reveal an (empty) custom input, not snap back.
  const input = await screen.findByLabelText('Gemini custom model ID') as HTMLInputElement
  expect(input.value).toBe('')
})

test('save drops overrides for engines that are not selected', async () => {
  const onSave = renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro', openai: 'gpt-5-mini' } })
  await screen.findByLabelText('Model')
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save engines' })) })
  // openai is not a selected engine, so its lingering override must not persist.
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini'], providerModels: { gemini: 'gemini-2.5-pro' } }))
})

test('a research-only save preserves checked native engines and models while their key is unavailable', async () => {
  const onSave = renderSection(undefined, {
    name: 'demo', providers: ['gemini', 'openai'], providerModels: { openai: 'gpt-5-mini' }, researchProvider: null,
  })
  const openai = await screen.findByLabelText('openai') as HTMLInputElement
  expect(openai.checked).toBe(true)
  expect(screen.getByText('Not configured, skipped')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'route:research-gateway' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({
    providers: ['gemini', 'openai'], providerModels: { openai: 'gpt-5-mini' }, researchProvider: 'route:research-gateway',
  }))
})

test('an unavailable-only native selection can save research without being replaced by automatic sweeps', async () => {
  const onSave = renderSection(undefined, {
    name: 'demo', providers: ['openai'], providerModels: { openai: 'gpt-5-mini' }, researchProvider: null,
  })
  await screen.findByLabelText('Research route')
  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'route:research-gateway' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({
    providers: ['openai'], providerModels: { openai: 'gpt-5-mini' }, researchProvider: 'route:research-gateway',
  }))
})

test('explicitly deselecting an unavailable native engine still removes its saved model', async () => {
  const onSave = renderSection(undefined, {
    name: 'demo', providers: ['gemini', 'openai'], providerModels: { openai: 'gpt-5-mini' },
  })
  const openai = await screen.findByLabelText('openai')
  fireEvent.click(openai)
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ providers: ['gemini'], providerModels: {} }))
})

test.each(['vercel-ai-gateway', 'litellm', 'custom-openai-compatible'] as const)('research readiness respects keyless policy for %s', async preset => {
  renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: {} }, {
    ...settings,
    engineConnections: [{ ...settings.engineConnections[0]!, preset, secretConfigured: false }],
  })
  const research = await screen.findByLabelText('Research route')
  expect((research.querySelector('option[value="route:research-gateway"]') as HTMLOptionElement).disabled).toBe(preset === 'vercel-ai-gateway')
})

test('migrates native route selections and model overrides to legacy providers', async () => {
  const onSave = renderSection(undefined, {
    name: 'demo', providers: ['native:gemini'], providerModels: { 'native:gemini': 'gemini-2.5-pro' }, researchProvider: 'native:gemini',
  })
  await screen.findByLabelText('Choose engines')
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'gemini' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({
    providers: ['gemini'],
    providerModels: { gemini: 'gemini-2.5-pro' },
    researchProvider: 'gemini',
  }))
})

test('does not let a configured route self-assert sweep eligibility', async () => {
  renderSection(undefined, { name: 'demo', providers: ['gemini'], providerModels: {} }, {
    ...settings,
    engineRoutes: [
      ...settings.engineRoutes,
      {
        id: 'route:claimed',
        label: 'Claimed measurement',
        connectionId: 'gateway:research',
        modelId: 'claimed/model',
        revision: 1,
        source: 'configured' as const,
        capabilities: { kind: 'verified-measurement' as const, retrieval: true, citations: true, location: true, servedModel: true, fallback: 'disabled' as const },
      },
    ],
  })

  const control = await screen.findByLabelText('Claimed measurement') as HTMLInputElement
  expect(control.disabled).toBe(true)
  expect(screen.getAllByText('Text-only: research only')).toHaveLength(2)
})

test('keeps text-only routes unavailable to sweeps and permits them only as a research route', async () => {
  const onSave = renderSection(undefined, {
    name: 'demo', providers: ['gemini'], providerModels: {}, researchProvider: null,
  })
  await screen.findByLabelText('Research gateway')
  const textOnlySweepControl = screen.getByLabelText('Research gateway') as HTMLInputElement
  expect(textOnlySweepControl.disabled).toBe(true)
  expect(screen.getByText('Text-only: research only')).toBeTruthy()

  fireEvent.change(screen.getByLabelText('Research route'), { target: { value: 'route:research-gateway' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({
    providers: ['gemini'],
    providerModels: {},
    researchProvider: 'route:research-gateway',
  }))
})

test('keeps a stale research route visible without silently clearing it', async () => {
  const onSave = renderSection(
    undefined,
    { name: 'demo', providers: ['gemini'], providerModels: {}, researchProvider: 'route:research-gateway' },
    { ...settings, engineConnections: [] },
  )

  await screen.findByLabelText('Gemini')
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  expect(screen.getAllByText('Connection missing')).toHaveLength(1)
  expect((screen.getByLabelText('Research route') as HTMLSelectElement).value).toBe('route:research-gateway')
  expect(screen.getByText(/saved research route is unavailable/i)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Save engines' }))
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({
    providers: ['gemini'],
    providerModels: {},
  }))
  expect((screen.getByLabelText('Research route') as HTMLSelectElement).value).toBe('route:research-gateway')
})

test('a background project refetch does not clobber in-progress edits', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const restore = mockFetch(url => {
    if (url.split('?')[0]!.endsWith('/settings')) return jsonResponse(settings)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { rerender } = render(
    <QueryClientProvider client={client}><ProjectEngineSettingsSection project={{ name: 'demo', providers: [], providerModels: {} }} onSave={onSave} /></QueryClientProvider>,
  )
  await screen.findByLabelText('Choose engines')
  act(() => { fireEvent.click(screen.getByLabelText('Choose engines')) })
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
  // A dashboard poll hands down a fresh project object with identical data.
  rerender(
    <QueryClientProvider client={client}><ProjectEngineSettingsSection project={{ name: 'demo', providers: [], providerModels: {} }} onSave={onSave} /></QueryClientProvider>,
  )
  // The in-progress "Choose engines" selection must survive the refetch.
  expect((screen.getByLabelText('Choose engines') as HTMLInputElement).checked).toBe(true)
  expect((screen.getByLabelText('Gemini') as HTMLInputElement).checked).toBe(true)
})

test('does not mount a mutable engine editor for embeds', () => {
  window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  const requests: string[] = []
  const restore = mockFetch(url => {
    requests.push(pathOf(url))
    return jsonResponse({ error: { message: 'unexpected' } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProjectEngineSettingsSection project={{ name: 'demo', providers: [], providerModels: {} }} onSave={vi.fn()} /></QueryClientProvider>)

  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  expect(requests).toEqual([])
})

test('uses the safe route read for a view-only project setting summary', async () => {
  const requests: string[] = []
  const restore = mockFetch(url => {
    const path = pathOf(url)
    requests.push(path)
    if (path === '/api/v1/settings/engine-routes') {
      return jsonResponse({
        routes: [{
          id: 'native:gemini', label: 'Gemini', modelId: 'gemini-2.5-flash', revision: 1, source: 'implicit-native',
          readiness: { state: 'measurement-ready', measurementReady: true },
        }],
      })
    }
    return jsonResponse({ error: { message: `unexpected ${path}` } }, 500)
  })
  onTestFinished(restore)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
        <ProjectEngineSettingsSection project={{ name: 'demo', providers: ['gemini'], providerModels: {} }} onSave={vi.fn()} />
      </AccountProvider>
    </QueryClientProvider>,
  )

  await screen.findByRole('heading', { name: 'Available engine routes' })
  expect(screen.queryByRole('button', { name: 'Save engines' })).toBeNull()
  expect(requests).toEqual(['/api/v1/settings/engine-routes'])
})
