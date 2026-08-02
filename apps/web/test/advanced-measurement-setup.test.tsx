import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { AdvancedMeasurementSetup } from '../src/components/project/advanced-measurement/AdvancedMeasurementSetup.js'

afterEach(cleanup)

const importProperties = {
  importDraft: {
    sitemapUrl: '',
    examplePropertyUrl: '',
    preferredHost: '',
    propertyPathPattern: '',
    additionalHost: '',
    additionalPathPattern: '',
    excludedPaths: '',
  },
  onImportDraftChange: vi.fn(),
  onReviewSitemap: vi.fn(),
  reviewState: 'idle' as const,
  properties: [],
  propertiesState: 'ready' as const,
  propertiesSearch: '',
  onPropertiesSearchChange: vi.fn(),
  selectedPropertyIds: [],
  onSelectedPropertyIdsChange: vi.fn(),
  onContinue: vi.fn(),
  onRetryProperties: vi.fn(),
  onReturnToImport: vi.fn(),
}

const properties = [{ id: 'harbor-house', label: 'Harbor House', urlCount: 2 }]
const queries = {
  properties,
  queries: [],
  selectedPropertyIds: [],
  selectedQueryIds: [],
  onSelectedPropertyIdsChange: vi.fn(),
  onSelectedQueryIdsChange: vi.fn(),
  onApplySelectedQueries: vi.fn(),
  onRemoveQuery: vi.fn(),
  onContinue: vi.fn(),
}

const groups = {
  properties,
  groups: [],
  groupDraft: { name: '', propertyIds: [], competitorDomains: '' },
  onGroupDraftChange: vi.fn(),
  onSaveGroup: vi.fn(),
  onSkipGroups: vi.fn(),
  onContinue: vi.fn(),
}

const review = {
  counts: { properties: 1, queries: 0, groups: 0 },
  flaggedExceptions: [],
  canPublish: false,
  onPublish: vi.fn(),
}

describe('advanced measurement setup composition', () => {
  it.each([
    ['import', 'Sitemap URL'],
    ['properties', 'Properties'],
    ['queries', 'Where these queries come from'],
    ['groups', 'Group name'],
    ['review', 'Flagged exceptions'],
  ] as const)('renders the %s step inside the shared draft shell', (currentStep, expectedText) => {
    const stepProps = currentStep === 'import' || currentStep === 'properties'
      ? { currentStep, importProperties }
      : currentStep === 'queries'
        ? { currentStep, queries }
        : currentStep === 'groups'
          ? { currentStep, groups }
          : { currentStep, review }

    render(
      <AdvancedMeasurementSetup
        canEdit
        hasDraft
        onDiscard={vi.fn()}
        {...stepProps}
      />,
    )

    expect(screen.getByText('Unpublished changes')).toBeTruthy()
    expect(screen.getAllByText(expectedText).length).toBeGreaterThan(0)
  })

  it('threads the empty-library action into the Queries step', () => {
    const onManageProjectQueries = vi.fn()
    render(
      <AdvancedMeasurementSetup
        currentStep="queries"
        canEdit
        hasDraft
        onManageProjectQueries={onManageProjectQueries}
        queries={queries}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage project queries' }))
    expect(onManageProjectQueries).toHaveBeenCalledTimes(1)
  })
})
