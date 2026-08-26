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
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CHART_AXIS_TICK,
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_STYLE,
  CHART_SERIES_COLORS,
  formatChartDateLabel,
  formatChartDateTick,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { Card } from '../ui/card.js'
import { useServerTrafficEvents } from '../../queries/server-traffic.js'

const CRAWLER_COLOR = CHART_SERIES_COLORS[0]
const FETCH_COLOR = CHART_SERIES_COLORS[1]
const VISIT_COLOR = CHART_SERIES_COLORS[2]

function compact(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString()
}

interface Point {
  bucket: string
  crawlerContentHits: number
  aiUserFetchHits: number
  aiReferralLandedHits: number
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
  const events = useServerTrafficEvents(projectName, { sinceMinutes, granularity: 'day' })

  const points: Point[] = useMemo(() => {
    const raw = (events.data as { series?: { points?: Point[] } } | undefined)?.series?.points
    return raw ?? []
  }, [events.data])

  const totals = useMemo(() => points.reduce(
    (acc, p) => ({
      crawlers: acc.crawlers + p.crawlerContentHits,
      fetches: acc.fetches + p.aiUserFetchHits,
      visits: acc.visits + p.aiReferralLandedHits,
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

      <div className="mb-2 flex items-center justify-between gap-3">
        {/* Tooltip is a SIBLING of the heading: nesting an interactive button
            inside <h3> changes the heading's accessible name. */}
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-heading">Machines reading your site</h3>
          <InfoTooltip text="Crawlers index pages for later. Page fetches happen while an engine is answering someone. Both are machines, not people." />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showFetches}
            onChange={(e) => setShowFetches(e.target.checked)}
            className="accent-current"
          />
          Page fetches
        </label>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="bucket" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE}
                 tickFormatter={formatChartDateTick} minTickGap={28} />
          <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={48} allowDecimals={false} />
          <RechartsTooltip contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                           labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                           itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                           labelFormatter={formatChartDateLabel} />
          <Area type="monotone" dataKey="crawlerContentHits" name="Pages crawled"
                stroke={CRAWLER_COLOR} fill={CRAWLER_COLOR} fillOpacity={0.22} strokeWidth={1.8} />
          {showFetches && (
            <Area type="monotone" dataKey="aiUserFetchHits" name="Page fetches"
                  stroke={FETCH_COLOR} fill={FETCH_COLOR} fillOpacity={0.18} strokeWidth={1.6} />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <div className="flex items-center gap-1.5 mt-5 mb-2">
        <h3 className="text-sm font-semibold text-heading">People arriving from AI</h3>
        <InfoTooltip text="Visits your own server answered, counted from server logs rather than a browser tag. A visit answered with a redirect is not counted, because the person had not arrived yet." />
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="bucket" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE}
                 tickFormatter={formatChartDateTick} minTickGap={28} />
          <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={48} allowDecimals={false} />
          <RechartsTooltip contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                           labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                           itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                           labelFormatter={formatChartDateLabel} />
          <Line type="monotone" dataKey="aiReferralLandedHits" name="Visits, server"
                stroke={VISIT_COLOR} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  )
}
