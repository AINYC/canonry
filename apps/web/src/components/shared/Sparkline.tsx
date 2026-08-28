import { useId } from 'react'
import { isTrendBaseline } from '@ainyc/canonry-contracts'
import type { MetricTone } from '../../view-models.js'

/**
 * Smallest span, in the series' own units, that the plot will scale to.
 *
 * Without a floor the plot normalizes to the series' own min and max, so a
 * one-query change and a total collapse render identically. The real case that
 * prompted this was [69, 69, 63] — eleven of sixteen queries mentioned becoming
 * ten — drawn as a full-height cliff. These series are percentages, so 20
 * points is a meaningful move, and anything smaller now occupies proportionally
 * less of the box: a 6-point change reads as about a third of the height, which
 * is what it is.
 */
const MIN_SPAN = 20

/**
 * Gap kept between the lowest plotted point and the guide line.
 *
 * The guide sits at the bottom of the box and reads as a floor. Before this,
 * the series minimum mapped to exactly that y — both resolved to
 * `height - padding` — so every sparkline's low point sat on the line and
 * looked like it had fallen to zero, whatever the value actually was.
 */
const GUIDE_GAP = 6

export function Sparkline({ points, tone }: { points: number[]; tone: MetricTone }) {
  const clipId = useId()
  if (points.length === 0) return null
  const height = 42
  const width = 132
  const padding = 5
  const innerWidth = width - padding * 2
  const innerHeight = height - padding * 2
  const plotHeight = innerHeight - GUIDE_GAP
  const xOf = (index: number): number => padding + (index / Math.max(points.length - 1, 1)) * innerWidth

  // Below the meaningful-sample floor the line is still DRAWN — a portfolio row
  // without a chart loses the shape a reader scans for — but drawn dashed, so
  // the sample size is visible in the mark itself rather than only in a caption
  // nobody reads. Suppressing it entirely was the first attempt and it removed
  // the graph, which is the wrong trade: the honest fix for an over-dramatic
  // line is scaling it truthfully, not deleting it.
  const provisional = isTrendBaseline(points)

  const min = Math.min(...points)
  const max = Math.max(...points)
  // Centre the series inside the floor span, so a small move sits in the middle
  // of the box rather than being stretched across it.
  const span = Math.max(max - min, MIN_SPAN)
  const low = (max + min) / 2 - span / 2
  const yOf = (point: number): number => padding + (1 - (point - low) / span) * plotHeight
  const coordinates = points.map((point, index) => `${xOf(index)},${yOf(point)}`).join(' ')
  // Single-reading dot position (see the render branch below).
  const dotY = yOf(points[0])

  return (
    <svg
      className={`sparkline sparkline-${tone}${provisional ? ' sparkline-provisional' : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={padding} y={padding} width={innerWidth} height={innerHeight} rx="8" />
        </clipPath>
      </defs>
      <line className="sparkline-guide" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
      {points.length === 1 ? (
        // A one-coordinate polyline draws nothing, so a first-sweep row showed
        // only the guide line — a blank rectangle with a stray dash. Render the
        // single reading as a dot instead: a zero-length segment with a round
        // cap, centred horizontally, at the value's y. The stroke colour still
        // comes from the `.sparkline-<tone> polyline` CSS, so the tone class
        // keeps working; the inline style only widens the cap into a visible
        // marker and defeats the provisional dash pattern (a dashed dot can
        // render as nothing).
        <polyline
          clipPath={`url(#${clipId})`}
          points={`${width / 2},${dotY} ${width / 2},${dotY}`}
          style={{ strokeWidth: 7, strokeDasharray: 'none' }}
        />
      ) : (
        <polyline clipPath={`url(#${clipId})`} points={coordinates} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  )
}
