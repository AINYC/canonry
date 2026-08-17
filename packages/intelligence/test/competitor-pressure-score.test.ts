import { describe, expect, it } from 'vitest'
import {
  buildCompetitorPressureScore,
  buildOverviewCompetitors,
  type CompetitorPressureSnapshot,
} from '../src/competitor-pressure-score.js'

function snap(overrides: Partial<CompetitorPressureSnapshot> = {}): CompetitorPressureSnapshot {
  return {
    queryId: 'q1',
    citedDomains: [],
    ...overrides,
  }
}

describe('buildCompetitorPressureScore', () => {
  it('returns "None" when there are no snapshots', () => {
    const result = buildCompetitorPressureScore([], ['rival.com'], 1)
    expect(result.value).toBe('None')
    expect(result.delta).toBe('No overlap detected')
    expect(result.tone).toBe('neutral')
  })

  it('returns "None" when there are no configured competitors', () => {
    const result = buildCompetitorPressureScore([snap()], [], 0)
    expect(result.value).toBe('None')
    expect(result.description).toBe('No competitors configured.')
  })

  it('labels High and tone=negative when ratio >= 0.5', () => {
    const snapshots = [
      snap({ citedDomains: ['rival.com'] }),
      snap({ citedDomains: ['rival.com'] }),
      snap({ citedDomains: [] }),
    ]
    const result = buildCompetitorPressureScore(snapshots, ['rival.com'], 1)
    expect(result.value).toBe('High')
    expect(result.tone).toBe('negative')
    expect(result.delta).toBe('2 overlapping citations')
  })

  it('labels Moderate and tone=caution when ratio in [0.2, 0.5)', () => {
    const snapshots = [
      ...Array.from({ length: 2 }, () => snap({ citedDomains: ['rival.com'] })),
      ...Array.from({ length: 6 }, () => snap({ citedDomains: [] })),
    ]
    const result = buildCompetitorPressureScore(snapshots, ['rival.com'], 1)
    expect(result.value).toBe('Moderate')
    expect(result.tone).toBe('caution')
  })

  it('labels Low and tone=neutral when ratio in (0, 0.2)', () => {
    const snapshots = [
      snap({ citedDomains: ['rival.com'] }),
      ...Array.from({ length: 9 }, () => snap({ citedDomains: [] })),
    ]
    const result = buildCompetitorPressureScore(snapshots, ['rival.com'], 1)
    expect(result.value).toBe('Low')
    expect(result.tone).toBe('neutral')
  })

  it('singularizes "competitor" in description when only 1 tracked', () => {
    const result = buildCompetitorPressureScore([], ['rival.com'], 1)
    expect(result.description).toBe('1 competitor tracked.')
  })

  it('pluralizes "competitors" in description when more than 1 tracked', () => {
    const result = buildCompetitorPressureScore([], ['rival.com', 'foe.com'], 2)
    expect(result.description).toBe('2 competitors tracked.')
  })

  it('counts a snapshot toward overlap only when the cited source list intersects the configured set', () => {
    const snapshots = [
      snap({ citedDomains: ['unconfigured.com'] }),
      snap({ citedDomains: ['rival.com'] }),
    ]
    const result = buildCompetitorPressureScore(snapshots, ['rival.com'], 1)
    expect(result.delta).toBe('1 overlapping citations')
  })
})

describe('buildOverviewCompetitors', () => {
  it('returns empty when no competitors are configured', () => {
    const result = buildOverviewCompetitors([snap()], [])
    expect(result).toEqual([])
  })

  it('returns a row per configured competitor with zero counts when no overlap', () => {
    const result = buildOverviewCompetitors(
      [snap()],
      [{ domain: 'rival.com' }, { domain: 'foe.com' }],
    )
    expect(result.map(r => r.domain)).toEqual(['rival.com', 'foe.com'])
    expect(result.every(r => r.citationCount === 0 && r.pressureLabel === 'None')).toBe(true)
  })

  it('uses provided id when set, falls back to comp_<index>', () => {
    const result = buildOverviewCompetitors(
      [snap()],
      [{ id: 'cust-1', domain: 'a.com' }, { domain: 'b.com' }],
    )
    expect(result[0]?.id).toBe('cust-1')
    expect(result[1]?.id).toBe('comp_1')
  })

  it('counts a competitor citation when its domain appears in citedDomains for any snapshot', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citedDomains: ['rival.com'] }),
    ]
    const result = buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }])
    const rival = result[0]!
    expect(rival.citationCount).toBe(2)
    // Without a lookup, falls back to queryIds.
    expect(rival.citedQueries).toEqual(['q1', 'q2'])
  })

  it('returns query text when a lookup is provided', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q2', citedDomains: ['rival.com'] }),
    ]
    const lookup = { byId: new Map([['q1', 'best CRM'], ['q2', 'top SaaS']]) }
    const result = buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }], lookup)
    expect(result[0]?.citedQueries).toEqual(['best CRM', 'top SaaS'])
  })

  it('counts subdomains of a configured competitor', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['blog.rival.com'] }),
    ]
    const result = buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }])
    expect(result[0]?.citationCount).toBe(1)
  })

  it('totalQueries reflects unique queryIds across all snapshots', () => {
    const snapshots = [
      snap({ queryId: 'q1' }),
      snap({ queryId: 'q1' }),
      snap({ queryId: 'q2' }),
    ]
    const result = buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }])
    expect(result[0]?.totalQueries).toBe(2)
  })

  it('labels pressure correctly across all four bands per-competitor', () => {
    const make = (count: number, total: number) => [
      ...Array.from({ length: count }, (_, i) =>
        snap({ queryId: `q${i}`, citedDomains: ['rival.com'] }),
      ),
      ...Array.from({ length: total - count }, (_, i) =>
        snap({ queryId: `f${i}` }),
      ),
    ]

    expect(buildOverviewCompetitors(make(5, 10), [{ domain: 'rival.com' }])[0]?.pressureLabel).toBe('High')
    expect(buildOverviewCompetitors(make(2, 10), [{ domain: 'rival.com' }])[0]?.pressureLabel).toBe('Moderate')
    expect(buildOverviewCompetitors(make(1, 10), [{ domain: 'rival.com' }])[0]?.pressureLabel).toBe('Low')
    expect(buildOverviewCompetitors(make(0, 10), [{ domain: 'rival.com' }])[0]?.pressureLabel).toBe('None')
  })

  it('citedQueries are sorted', () => {
    const snapshots = [
      snap({ queryId: 'banana', citedDomains: ['rival.com'] }),
      snap({ queryId: 'apple', citedDomains: ['rival.com'] }),
    ]
    const result = buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }])
    expect(result[0]?.citedQueries).toEqual(['apple', 'banana'])
  })

  it('falls back to queryId for snapshots whose queryId is not in the lookup', () => {
    const snapshots = [
      snap({ queryId: 'q1', citedDomains: ['rival.com'] }),
      snap({ queryId: 'q-missing', citedDomains: ['rival.com'] }),
    ]
    const lookup = { byId: new Map([['q1', 'best CRM']]) }
    const result = buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }], lookup)
    expect(result[0]?.citedQueries).toEqual(['best CRM', 'q-missing'])
  })
})

describe('competitor pressure is the citation signal only', () => {
  // `query_snapshots.competitor_overlap` unions cited domains, grounding hosts
  // AND answer-text brand matches. Every field these builders emit is named for
  // the citation signal (`citationCount`, `citedQueries`, "overlapping
  // citations"), so a competitor the engine merely NAMED must not raise them —
  // that number would be a mention reported under a citation's name.
  it('a competitor named in prose but absent from the source list adds no pressure', () => {
    const snapshots: CompetitorPressureSnapshot[] = [
      { queryId: 'q1', citedDomains: [] },
      { queryId: 'q2', citedDomains: [] },
    ]
    const gauge = buildCompetitorPressureScore(snapshots, ['rival.com'], 1)
    expect(gauge.value).toBe('None')
    expect(gauge.delta).toBe('No overlap detected')

    const rows = buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }])
    expect(rows[0]!.citationCount).toBe(0)
    expect(rows[0]!.citedQueries).toEqual([])
    expect(rows[0]!.pressureLabel).toBe('None')
  })

  it('the same competitor raises pressure once it is actually cited', () => {
    const snapshots: CompetitorPressureSnapshot[] = [
      { queryId: 'q1', citedDomains: ['rival.com'] },
      { queryId: 'q2', citedDomains: [] },
    ]
    // 1 of 2 snapshots = ratio 0.5, which is the High band's lower bound.
    expect(buildCompetitorPressureScore(snapshots, ['rival.com'], 1).value).toBe('High')
    expect(buildCompetitorPressureScore(snapshots, ['rival.com'], 1).delta).toBe('1 overlapping citations')
    expect(buildOverviewCompetitors(snapshots, [{ domain: 'rival.com' }])[0]!.citationCount).toBe(1)
  })
})
