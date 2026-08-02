import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PortfolioSection } from '../src/components/project/PortfolioSection'

// A project whose plan is published is being READ, not set up. Landing it on a
// setup step made a configured project look unconfigured: the founder opened one
// with an active revision and got an empty "Import sitemap" form, which reads as
// though nothing had been saved. These pin where each state lands.

const plan = {
  schemaVersion: 1 as const,
  targets: [{
    stableKey: 'harbor',
    label: 'Harbor',
    aliases: ['Harbor Place'],
    urls: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: '/homes/harbor', pathCase: 'insensitive' as const }],
  }],
  groups: [],
  targetQuerySelections: [],
}

const noop = async () => { throw new Error('not called in this test') }

function renderSection(over: Record<string, unknown> = {}) {
  return render(
    <PortfolioSection
      projectName="northstar"
      queries={[]}
      activePlan={null}
      isPlanLoading={false}
      isPlanError={false}
      onDiscover={noop}
      onCreateQueries={noop}
      onCompilePlan={noop}
      onDiffPlan={noop}
      onPublishPlan={noop}
      {...over}
    />,
  )
}

describe('portfolio landing state', () => {
  it('lands a published plan on the report, not on a setup step', async () => {
    renderSection({ activePlan: { revision: 1, checksum: 'abc123', plan } })
    await waitFor(() => {
      // Assert the REPORT is showing, not merely that Import is absent: the old
      // behaviour landed on Targets, which also has no Import heading, so a
      // negative assertion alone passes against the bug.
      expect(screen.getAllByRole('heading', { name: /^report$/i }).length).toBeGreaterThan(0)
    })
    expect(screen.queryByRole('heading', { name: /import sitemap/i })).toBeNull()
  })

  it('keeps the setup steps reachable from the published state', async () => {
    renderSection({ activePlan: { revision: 1, checksum: 'abc123', plan } })
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^import$/i }).length).toBeGreaterThan(0)
    })
  })

  it('starts a project with no plan at Import, which is a real first run', () => {
    renderSection()
    expect(screen.getByRole('heading', { name: /import sitemap/i })).toBeTruthy()
  })

  it('never prefills the path field with an example belonging to another site', () => {
    renderSection()
    const field = screen.getAllByLabelText(/target path pattern/i)[0] as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toContain('/locations/')
  })
})
