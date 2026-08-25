import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  formatMicros,
  type GoogleAdsCampaignStatus,
  type GoogleAdsMetricsWindow,
  type GoogleAdsPerformanceDto,
} from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameGoogleAdsPerformanceOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../api.js'
import { extractErrorMessage } from '../../lib/extract-error-message.js'
import type { MetricTone } from '../../view-models.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import {
  CHART_SERIES_COLORS,
  MultiAxisTrendChart,
  formatChartDateLabel,
  formatChartDateTick,
  formatObservedInstantLabel,
  observedInstant,
  type TrendChartSeries,
} from '../shared/ChartPrimitives.js'
import { Button } from '../ui/button.js'

const GOOGLE_ADS_PERFORMANCE_STALE_MS = 60_000
const GOOGLE_ADS_WINDOWS: GoogleAdsMetricsWindow[] = ['7d', '14d', '28d']

/**
 * A ratio whose denominator was zero is UNDEFINED, not zero. The API sends
 * `null` for exactly that case, so every rate cell renders this word instead of
 * a number a reader would otherwise average, sort, or quote.
 */
export const GOOGLE_ADS_NOT_AVAILABLE = 'not available'

export const GOOGLE_ADS_PERFORMANCE_HELP = 'Figures come from the stored Google Ads snapshot; this view never calls Google. The window ends on the newest CLOSED day, because the capture day is only partly recorded and would read as a drop. A calendar day the provider returned no row for is zero delivery, so it is charted as zero. Rates with a zero denominator read "not available", never 0%.'

export const GOOGLE_ADS_PERFORMANCE_EMPTY_TITLE = 'No Google Ads snapshot stored yet'

export const GOOGLE_ADS_PERFORMANCE_EMPTY_BODY = 'Connect a Google Ads account in Conversion Integrity below, choose the customer, then run a Google Ads sync. Spend, clicks, impressions, and conversions appear here once the first snapshot is stored.'

export const GOOGLE_ADS_PERFORMANCE_AWAITING_TITLE = 'No closed days yet'
export const GOOGLE_ADS_PERFORMANCE_AWAITING_BODY = 'Google Ads is connected and syncing. Figures appear once a full day has closed in the account time zone; the day a snapshot is captured is partial and is left out on purpose.'

/**
 * Only 'insufficient-history' can reach the comparison line. The route emits
 * 'no-snapshot' exclusively alongside `source: null`, which returns earlier, so a
 * 'no-snapshot' entry here would be dead copy that implies a state this branch
 * never renders.
 */
export const GOOGLE_ADS_COMPARISON_UNAVAILABLE_COPY: Record<'insufficient-history', string> = {
  'insufficient-history': 'Period change is hidden: the stored snapshot does not cover a prior period of equal length yet.',
}

const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
/** Google reports fractional conversions, so 0.5 is a real value, not a rounding artifact. */
const CONVERSION_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const PERCENT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

/** A raw ratio (0.0731) as a display percentage. Never rounded before this point. */
export function formatGoogleAdsRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return GOOGLE_ADS_NOT_AVAILABLE
  return `${PERCENT_FORMAT.format(ratio * 100)}%`
}

/**
 * A period-over-period change from `comparison.change`.
 *
 * Called only when a comparison EXISTS. A missing comparison renders no delta
 * at all: printing "0%" for a period that was never measured invents a flat
 * reading out of absent data.
 */
export function formatGoogleAdsChange(ratio: number | null, days: number): string {
  if (ratio === null || !Number.isFinite(ratio)) return `${GOOGLE_ADS_NOT_AVAILABLE} vs prior ${days}d`
  if (ratio === 0) return `no change vs prior ${days}d`
  const percent = Math.abs(ratio * 100)
  const formatted = percent < 0.1 ? '<0.1%' : `${PERCENT_FORMAT.format(percent)}%`
  return `${ratio > 0 ? '↑' : '↓'} ${formatted} vs prior ${days}d`
}

function campaignStatusTone(status: GoogleAdsCampaignStatus): MetricTone {
  if (status === 'enabled') return 'positive'
  if (status === 'paused') return 'caution'
  return 'neutral'
}

function campaignStatusLabel(status: GoogleAdsCampaignStatus): string {
  if (status === 'enabled') return 'Enabled'
  if (status === 'paused') return 'Paused'
  if (status === 'removed') return 'Removed'
  return 'Unknown'
}

/**
 * Delta colour is a claim about whether the movement is GOOD, so only metrics
 * with an unambiguous direction get one. More clicks, impressions, and
 * conversions are better. More spend is neither: without a return figure beside
 * it, a green "spend up 40%" would be an assertion the data does not support.
 */
function changeToneClass(ratio: number | null, directional: boolean): string {
  if (!directional || ratio === null || !Number.isFinite(ratio) || ratio === 0) return 'text-muted'
  return ratio > 0 ? 'text-positive' : 'text-negative'
}

export function GoogleAdsPerformanceSection({ projectName }: { projectName: string }) {
  const [metricsWindow, setMetricsWindow] = useState<GoogleAdsMetricsWindow>('14d')
  const performanceQuery = useQuery({
    ...getApiV1ProjectsByNameGoogleAdsPerformanceOptions({
      client: heyClient,
      path: { name: projectName },
      query: { window: metricsWindow },
    }),
    staleTime: GOOGLE_ADS_PERFORMANCE_STALE_MS,
  })

  const performance: GoogleAdsPerformanceDto | undefined = performanceQuery.data

  const header = (
    <div className="section-head section-head-inline">
      <div>
        <p className="eyebrow">Google Ads</p>
        <div className="flex items-center gap-1.5">
          <h2 id="google-ads-performance-title" className="text-xl font-semibold tracking-[-0.02em] text-heading">
            Ad performance
          </h2>
          <InfoTooltip text={GOOGLE_ADS_PERFORMANCE_HELP} />
        </div>
        {performance?.source ? (
          <p className="text-xs text-muted">
            {formatChartDateLabel(performance.startDate)} to {formatChartDateLabel(performance.endDate)}
            {' · '}{performance.days} closed {performance.days === 1 ? 'day' : 'days'}
          </p>
        ) : null}
      </div>
      <div className="segmented" role="group" aria-label="Ad performance time period">
        {GOOGLE_ADS_WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={metricsWindow === option}
            className={`segmented-option ${metricsWindow === option ? 'segmented-option-active' : ''}`}
            onClick={() => setMetricsWindow(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )

  if (performanceQuery.isLoading) {
    return (
      <section className="page-section" aria-busy="true" aria-labelledby="google-ads-performance-title">
        {header}
        <div aria-hidden="true" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="page-skeleton-card">
              <div className="skeleton-text w-20" />
              <div className="skeleton-text-sm w-28" />
            </div>
          ))}
        </div>
        <p role="status" className="sr-only">Loading Google Ads performance…</p>
      </section>
    )
  }

  if (performanceQuery.isError || !performance) {
    return (
      <section className="page-section" aria-labelledby="google-ads-performance-title">
        {header}
        <p role="alert" className="mt-4 text-sm text-negative">
          Could not load Google Ads performance: {extractErrorMessage(performanceQuery.error)}
        </p>
        <Button type="button" variant="outline" className="mt-3" onClick={() => void performanceQuery.refetch()}>
          Retry performance
        </Button>
      </section>
    )
  }

  const { totals, daily, campaigns, comparison, comparisonUnavailableReason, source } = performance

  // No stored snapshot at all. Onboarding copy is the one place this surface is
  // allowed to instruct inline, because there is no data to push down.
  if (!source) {
    // `source: null` carries two different situations and they need different copy.
    // 'insufficient-history' means the account IS connected and synced but no day
    // has closed yet; telling that operator to connect an account is wrong.
    const awaitingFirstClosedDay = comparisonUnavailableReason === 'insufficient-history'
    return (
      <section className="page-section" aria-labelledby="google-ads-performance-title">
        {header}
        <div className="mt-4 max-w-2xl rounded-md border border-default bg-surface-subtle p-5">
          <h3 className="text-base font-semibold text-heading">
            {awaitingFirstClosedDay
              ? GOOGLE_ADS_PERFORMANCE_AWAITING_TITLE
              : GOOGLE_ADS_PERFORMANCE_EMPTY_TITLE}
          </h3>
          <p className="mt-2 text-sm leading-6 text-secondary">
            {awaitingFirstClosedDay
              ? GOOGLE_ADS_PERFORMANCE_AWAITING_BODY
              : GOOGLE_ADS_PERFORMANCE_EMPTY_BODY}
          </p>
        </div>
      </section>
    )
  }

  const currency = source.currencyCode ?? 'USD'
  // The row cap (`truncated`) and the 50-campaign query cap are DIFFERENT limits.
  // An account with more than 50 campaigns is summed from the queried subset while
  // `truncated` stays false, so gating this on `truncated` would print a subtotal
  // as the account total with no caveat at all. Compare the counts directly.
  // `campaignsInInventory` is 0 when no inventory snapshot is stored, which proves
  // nothing about coverage, so that case is not reported as a shortfall.
  const coverageShortfall =
    source.campaignsInInventory > 0 && source.campaignsQueried < source.campaignsInInventory
      ? { queried: source.campaignsQueried, inInventory: source.campaignsInInventory }
      : null
  const tiles: {
    key: string
    label: string
    value: string
    change: number | null
    directional: boolean
  }[] = [
    { key: 'spend', label: 'Spend', value: formatMicros(totals.costMicros, currency), change: comparison?.change.costMicros ?? null, directional: false },
    { key: 'clicks', label: 'Clicks', value: COUNT_FORMAT.format(totals.clicks), change: comparison?.change.clicks ?? null, directional: true },
    { key: 'impressions', label: 'Impressions', value: COUNT_FORMAT.format(totals.impressions), change: comparison?.change.impressions ?? null, directional: true },
    { key: 'conversions', label: 'Conversions', value: CONVERSION_FORMAT.format(totals.conversions), change: comparison?.change.conversions ?? null, directional: true },
  ]

  const chartSeries: TrendChartSeries[] = [
    {
      dataKey: 'costMicros',
      label: 'Spend',
      color: CHART_SERIES_COLORS[1],
      axisId: 'spend',
      // Micros stay integers all the way to the axis; the formatter is the
      // single render edge that turns them into money.
      formatValue: (value: number) => formatMicros(value, currency),
    },
    {
      dataKey: 'conversions',
      label: 'Conversions',
      color: CHART_SERIES_COLORS[0],
      axisId: 'conversions',
      formatValue: (value: number) => CONVERSION_FORMAT.format(value),
    },
  ]

  return (
    <section className="page-section" aria-labelledby="google-ads-performance-title">
      {header}

      {coverageShortfall !== null ? (
        <p role="status" className="mt-3 text-sm text-caution">
          Totals cover {COUNT_FORMAT.format(coverageShortfall.queried)} of{' '}
          {COUNT_FORMAT.format(coverageShortfall.inInventory)} campaigns, so they are a subset of the account.
        </p>
      ) : null}

      {source.truncated ? (
        <p role="status" className="mt-3 text-sm text-caution">
          The provider row cap was reached, so some days are missing from the figures below.
        </p>
      ) : null}

      {!comparison && comparisonUnavailableReason === 'insufficient-history' ? (
        <p className="mt-3 text-sm text-secondary">
          {GOOGLE_ADS_COMPARISON_UNAVAILABLE_COPY['insufficient-history']}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.key} className="rounded-md border border-subtle bg-surface-subtle px-3 py-2">
            <span className="block text-xs text-secondary">{tile.label}</span>
            <span className="mt-0.5 block text-lg tabular-nums text-strong">{tile.value}</span>
            {comparison ? (
              <span className={`block text-[11px] tabular-nums ${changeToneClass(tile.change, tile.directional)}`}>
                {formatGoogleAdsChange(tile.change, comparison.days)}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-4">
        <MultiAxisTrendChart
          data={daily}
          xKey="date"
          series={chartSeries}
          xTickFormatter={formatChartDateTick}
          labelFormatter={formatChartDateLabel}
        />
        {/* Recharts owns the SVG and exposes no readable series, so the same
            days are listed for assistive tech. A densified day says so: it is a
            measured zero, not a gap in the record. */}
        <ul className="sr-only">
          {daily.map((point) => (
            <li key={point.date}>
              {formatChartDateLabel(point.date)}: {formatMicros(point.costMicros, currency)} spend, {CONVERSION_FORMAT.format(point.conversions)} conversions
              {point.origin === 'filled' ? ', no delivery reported' : ''}
            </li>
          ))}
        </ul>
      </div>

      <div className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">By campaign</p>
            <h3 className="text-base font-semibold text-heading">Campaign performance</h3>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <caption className="sr-only">Google Ads campaign performance for the selected window</caption>
            <thead>
              <tr>
                <th className="text-left">Campaign</th>
                <th className="text-left">Status</th>
                <th className="text-right">Impressions</th>
                <th className="text-right">Clicks</th>
                <th className="text-right">Spend</th>
                <th className="text-right">Conversions</th>
                <th className="text-right">CTR</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-secondary">No campaign delivered in this window.</td>
                </tr>
              ) : campaigns.map((campaign) => (
                <tr key={campaign.campaignId}>
                  <td className="max-w-xs truncate text-strong">
                    {campaign.name ?? <span className="font-mono text-secondary">{campaign.campaignId}</span>}
                  </td>
                  <td><ToneBadge tone={campaignStatusTone(campaign.status)}>{campaignStatusLabel(campaign.status)}</ToneBadge></td>
                  <td className="text-right tabular-nums text-secondary">{COUNT_FORMAT.format(campaign.totals.impressions)}</td>
                  <td className="text-right tabular-nums text-secondary">{COUNT_FORMAT.format(campaign.totals.clicks)}</td>
                  <td className="text-right tabular-nums text-strong">{formatMicros(campaign.totals.costMicros, currency)}</td>
                  <td className="text-right tabular-nums text-secondary">{CONVERSION_FORMAT.format(campaign.totals.conversions)}</td>
                  <td className="text-right tabular-nums text-secondary">{formatGoogleAdsRatio(campaign.totals.ctr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-muted">
          Snapshot {formatObservedInstantLabel(observedInstant(source.capturedAt))}
          {' · '}customer {source.customerId}
          {' · '}latest closed day {formatChartDateLabel(source.asOfDate)}
          {source.openDate ? <>{' · '}{formatChartDateLabel(source.openDate)} still open, excluded</> : null}
        </p>
      </div>
    </section>
  )
}
