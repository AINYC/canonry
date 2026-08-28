/**
 * Daily history of machine and human AI traffic from the server-side lane.
 *
 * Deliberately fed by SERVER traffic only, and rendered as a sibling of the GA4
 * panel rather than inside it: the GA4 panel early-returns a connect prompt when
 * no property is bound, and this data exists with no GA4 at all. Nesting it
 * would hide it from exactly the projects it serves.
 *
 * "Pages crawled" reads `crawlerContentHits`, not `crawlerHits`. The latter
 * counts robots.txt and sitemap re-fetches, which are not pages an engine read.
 */
import { useMemo, useState } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Legend,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CHART_AXIS_TICK,
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_STYLE,
  ReferenceArea,
  CHART_SERIES_COLORS,
  formatChartDateLabel,
  formatChartDateTick,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { Card } from '../ui/card.js'
import { useServerTrafficEvents } from '../../queries/server-traffic.js'
import { getApiV1ProjectsByNameGaAiReferralDailyOptions } from '@ainyc/canonry-api-client/react-query'
import { useQuery } from '@tanstack/react-query'
import { heyClient } from '../../api.js'
import type { GA4AiReferralDailyDto } from '../../api.js'

const CRAWLER_COLOR = CHART_SERIES_COLORS[0]
const FETCH_COLOR = CHART_SERIES_COLORS[1]
const VISIT_COLOR = CHART_SERIES_COLORS[2]
const GA4_COLOR = CHART_SERIES_COLORS[3]

type VisitSource = 'both' | 'server' | 'ga4'

function compact(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString()
}

/**
 * Every numeric field is optional on the wire even though the schema requires
 * it. A deploy can put a newer client in front of an older API for minutes, and
 * this panel crashed exactly that way: the running API had no
 * `crawlerContentHits` on the series and `.toLocaleString()` on undefined took
 * the whole page down. A chart missing a series is a degraded chart; a chart
 * that throws is a blank page.
 */
interface Point {
  bucket: string
  measured?: boolean
  crawlerContentHits?: number
  aiUserFetchHits?: number
  aiReferralLandedHits?: number
}

/** Coerce a wire number that an older API may not send at all. */
const LEGEND_STYLE = { fontSize: 11, paddingTop: 6 } as const
/** Trend lines are the same colour as their series; naming them again in the
 *  legend doubles its length and says nothing new. */
const HIDDEN_FROM_LEGEND = new Set(['Pages crawled trend', 'Page fetches trend', 'Visits trend'])

const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

interface Trend { start: number; end: number; startIndex: number; endIndex: number }

/**
 * Two endpoints of a server-fitted line, expanded to a per-point series so
 * Recharts can draw it. The fit itself is NOT computed here: a regression in a
 * chart component is invisible to the CLI and breaks UI/CLI parity.
 */
function trendSeries(trend: Trend | null | undefined, length: number): (number | null)[] {
  if (!trend || length < 2) return Array<number | null>(length).fill(null)
  const span = trend.endIndex - trend.startIndex
  if (span <= 0) return Array<number | null>(length).fill(null)
  const perStep = (trend.end - trend.start) / span
  return Array.from({ length }, (_, i) =>
    i < trend.startIndex || i > trend.endIndex
      ? null
      : trend.start + (i - trend.startIndex) * perStep)
}

function Tile({ label, value, caption, tooltip }: {
  label: string
  value: string
  caption: string
  tooltip: string
}) {
  return (
    <div className="rounded-lg border border-default bg-bg/40 px-4 py-3 flex flex-col">
      <div className="flex items-center gap-1 mb-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p>
        <InfoTooltip text={tooltip} />
      </div>
      <p className="text-xl font-semibold text-primary tabular-nums">{value}</p>
      <p className="text-xs text-muted mt-0.5">{caption}</p>
    </div>
  )
}

export function AiTrafficHistoryPanel({
  projectName,
  sinceMinutes,
}: {
  projectName: string
  sinceMinutes: number
}) {
  const [showFetches, setShowFetches] = useState(true)
  const [showTrend, setShowTrend] = useState(true)
  const [visitSource, setVisitSource] = useState<VisitSource>('both')
  const events = useServerTrafficEvents(projectName, { sinceMinutes, granularity: 'day' })
  const gaDaily = useQuery({
    ...getApiV1ProjectsByNameGaAiReferralDailyOptions({
      client: heyClient,
      path: { name: projectName },
      query: { window: sinceMinutes >= 90 * 24 * 60 ? '90d' : sinceMinutes >= 30 * 24 * 60 ? '30d' : '7d' },
    }),
    enabled: Boolean(projectName),
  })

  const points: Point[] = useMemo(() => {
    const raw = (events.data as { series?: { points?: Point[] } } | undefined)?.series?.points
    return raw ?? []
  }, [events.data])

  // GA4 days with no referrals are ABSENT, not zero, so a missing day is null
  // rather than 0: the line breaks instead of implying a measured zero.
  const gaByDate = useMemo(() => {
    const dto = gaDaily.data as GA4AiReferralDailyDto | undefined
    return new Map((dto?.days ?? []).map((d) => [d.date, d.sessions]))
  }, [gaDaily.data])

  // The stretch before recording began. Charted as a band rather than left to
  // read as a flat zero, which is what an unmeasured day looks like otherwise.
  const unmeasured = useMemo(() => {
    // An API that predates `measured` sends undefined; treat that as measured,
    // otherwise the whole chart paints as a "not measured" band.
    const isMeasured = (pt: Point) => pt.measured !== false
    if (points.length === 0 || isMeasured(points[0]!)) return null
    const lastUnmeasured = points.findIndex(isMeasured) - 1
    if (lastUnmeasured < 0) return { from: points[0]!.bucket, to: points[points.length - 1]!.bucket }
    return { from: points[0]!.bucket, to: points[lastUnmeasured]!.bucket }
  }, [points])

  const trends = (events.data as { series?: { trends?: Record<string, Trend | null> } } | undefined)?.series?.trends

  const chartRows = useMemo(() => {
    const crawlTrend = trendSeries(trends?.crawlerContentHits, points.length)
    const fetchTrend = trendSeries(trends?.aiUserFetchHits, points.length)
    const visitTrend = trendSeries(trends?.aiReferralLandedHits, points.length)
    return points.map((pt, i) => ({
      ...pt,
      ga4Visits: gaByDate.get(pt.bucket) ?? null,
      crawlTrend: crawlTrend[i],
      fetchTrend: fetchTrend[i],
      visitTrend: visitTrend[i],
    }))
  }, [points, gaByDate, trends])

  const totals = useMemo(() => points.reduce(
    (acc, p) => ({
      crawlers: acc.crawlers + num(p.crawlerContentHits),
      fetches: acc.fetches + num(p.aiUserFetchHits),
      visits: acc.visits + num(p.aiReferralLandedHits),
    }),
    { crawlers: 0, fetches: 0, visits: 0 },
  ), [points])

  // A failed request and a quiet window are different facts and must not share a
  // message. The API densifies the window, so a successful empty range returns
  // zero-valued points rather than none: "no activity" is an all-zero series,
  // NOT an absent one. Reading `points.length === 0` as "no activity" showed a
  // request error as a calm "nothing happened".
  const measuredAnything = totals.crawlers > 0 || totals.fetches > 0 || totals.visits > 0

  if (events.isLoading) {
    return <Card className="surface-card p-5"><div className="text-sm text-muted">Loading AI traffic history…</div></Card>
  }
  if (events.isError) {
    return (
      <Card className="surface-card p-5">
        <p className="text-sm text-secondary">Could not load AI traffic history.</p>
        <p className="text-xs text-muted mt-1">
          The request failed, so this is not a reading of zero activity. Retry, or check the traffic source.
        </p>
      </Card>
    )
  }
  if (!measuredAnything) {
    return (
      <Card className="surface-card p-5">
        <p className="text-sm text-secondary">
          {points.length === 0
            ? 'No server-side traffic source connected yet.'
            : 'No AI activity recorded in this period.'}
        </p>
        <p className="text-xs text-muted mt-1">
          {points.length === 0
            ? 'Connect a traffic source to see how AI engines read this site over time.'
            : 'The window was measured and nothing was recorded. Try a longer range.'}
        </p>
      </Card>
    )
  }

  return (
    <Card className="surface-card p-5">
      <div className="grid gap-3 sm:grid-cols-3 mb-5">
        <Tile
          label="AI crawlers"
          value={compact(totals.crawlers)}
          caption="pages crawled"
          tooltip="Requests from AI crawlers for a real content page. Robots.txt and sitemap re-fetches are excluded, because they are not a page an engine read."
        />
        <Tile
          label="AI page fetches"
          value={compact(totals.fetches)}
          caption="reading a page to answer"
          tooltip="An AI engine fetching a page live while answering someone, rather than crawling it for an index."
        />
        <Tile
          label="AI visitors"
          value={compact(totals.visits)}
          caption="arrived from an AI answer"
          tooltip="Visits your server answered that came from an AI engine. Requests answered with a redirect are excluded: a redirect is a hop, not an arrival."
        />
      </div>

      {/* Last 24h: answers "what happened today" without reading a 90-day chart.
          The newest bucket, so it is the same lane as the charts below. */}
      {points.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 pb-3 mb-4 border-b border-default text-xs text-muted">
          <span className="text-secondary font-semibold">Last 24h</span>
          <span><span className="text-heading font-semibold tabular-nums mr-1">
            {num(points[points.length - 1]!.crawlerContentHits).toLocaleString()}</span>pages crawled</span>
          <span><span className="text-heading font-semibold tabular-nums mr-1">
            {num(points[points.length - 1]!.aiUserFetchHits).toLocaleString()}</span>page fetches</span>
          <span><span className="text-heading font-semibold tabular-nums mr-1">
            {num(points[points.length - 1]!.aiReferralLandedHits).toLocaleString()}</span>visits, server</span>
          <span><span className="text-heading font-semibold tabular-nums mr-1">
            {gaByDate.get(points[points.length - 1]!.bucket)?.toLocaleString() ?? '—'}</span>visits, GA4</span>
        </div>
      )}

      <div className="mb-2 flex items-center justify-between gap-3">
        {/* Tooltip is a SIBLING of the heading: nesting an interactive button
            inside <h3> changes the heading's accessible name. */}
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-heading">Machines reading your site</h3>
          <InfoTooltip text="Crawlers index pages for later. Page fetches happen while an engine is answering someone. Both are machines, not people." />
        </div>
        <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showFetches}
            onChange={(e) => setShowFetches(e.target.checked)}
            className="accent-current"
          />
          Page fetches
        </label>
        <label className="flex items-center gap-1.5 text-xs text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showTrend}
            onChange={(e) => setShowTrend(e.target.checked)}
            className="accent-current"
          />
          Trend line
        </label>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={206}>
        <ComposedChart data={chartRows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="bucket" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE}
                 tickFormatter={formatChartDateTick} minTickGap={28} />
          <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={48} allowDecimals={false} />
          <RechartsTooltip contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                           labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                           itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                           labelFormatter={formatChartDateLabel} />
          {unmeasured && (
            <ReferenceArea x1={unmeasured.from} x2={unmeasured.to} fill="var(--color-overlay-hover)"
                           fillOpacity={0.5} stroke="none"
                           label={{ value: 'not measured', position: 'insideTop', fontSize: 10, fill: 'var(--chart-neutral-text-dim, #71717a)' }} />
          )}
          <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" iconSize={14}
                  formatter={(value: string) => (HIDDEN_FROM_LEGEND.has(value) ? '' : value)} />
          <Area type="monotone" dataKey="crawlerContentHits" name="Pages crawled"
                stroke={CRAWLER_COLOR} fill={CRAWLER_COLOR} fillOpacity={0.22} strokeWidth={1.8} />
          {showFetches && (
            <Area type="monotone" dataKey="aiUserFetchHits" name="Page fetches"
                  stroke={FETCH_COLOR} fill={FETCH_COLOR} fillOpacity={0.18} strokeWidth={1.6} />
          )}
          {showTrend && (
            <Line type="linear" dataKey="crawlTrend" name="Pages crawled trend" dot={false}
                  stroke={CRAWLER_COLOR} strokeWidth={1.4} strokeDasharray="5 4" connectNulls />
          )}
          {showTrend && showFetches && (
            <Line type="linear" dataKey="fetchTrend" name="Page fetches trend" dot={false}
                  stroke={FETCH_COLOR} strokeWidth={1.3} strokeDasharray="5 4" connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <div className="flex items-center justify-between gap-3 mt-5 mb-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-heading">People arriving from AI</h3>
          <InfoTooltip text="Two independent counts of the same thing. Server reads your own logs and misses nothing a browser blocks, but cannot see a page served from cache. GA4 needs the browser to run a tag. They rarely match, and neither is the correction of the other." />
        </div>
        <div className="segmented" role="group" aria-label="Visit measurement source">
          {(['both', 'server', 'ga4'] as VisitSource[]).map((src) => (
            <button
              key={src}
              type="button"
              aria-pressed={visitSource === src}
              className={`segmented-option ${visitSource === src ? 'segmented-option-active' : ''}`}
              onClick={() => setVisitSource(src)}
            >
              {src === 'ga4' ? 'GA4' : src === 'both' ? 'Both' : 'Server'}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={176}>
        <ComposedChart data={chartRows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="bucket" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE}
                 tickFormatter={formatChartDateTick} minTickGap={28} />
          <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={48} allowDecimals={false} />
          <RechartsTooltip contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                           labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                           itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                           labelFormatter={formatChartDateLabel} />
          {unmeasured && (
            <ReferenceArea x1={unmeasured.from} x2={unmeasured.to} fill="var(--color-overlay-hover)"
                           fillOpacity={0.5} stroke="none"
                           label={{ value: 'not measured', position: 'insideTop', fontSize: 10, fill: 'var(--chart-neutral-text-dim, #71717a)' }} />
          )}
          <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" iconSize={14}
                  formatter={(value: string) => (HIDDEN_FROM_LEGEND.has(value) ? '' : value)} />
          {visitSource !== 'ga4' && (
            <Line type="monotone" dataKey="aiReferralLandedHits" name="Visits, server"
                  stroke={VISIT_COLOR} strokeWidth={2} dot={false} />
          )}
          {visitSource !== 'server' && (
            <Line type="monotone" dataKey="ga4Visits" name="Visits, GA4" connectNulls={false}
                  stroke={GA4_COLOR} strokeWidth={1.8} strokeDasharray="5 3" dot={false} />
          )}
          {showTrend && visitSource !== 'ga4' && (
            <Line type="linear" dataKey="visitTrend" name="Visits trend" dot={false}
                  stroke={VISIT_COLOR} strokeWidth={1.3} strokeDasharray="5 4" connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  )
}
