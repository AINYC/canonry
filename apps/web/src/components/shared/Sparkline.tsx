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

  // Too few readings to claim a direction, so don't draw one. The readings are
  // shown as evenly spaced dots instead of being connected into a trend the
  // sample cannot support. Both report renderers already refuse here and say
  // "building baseline"; this is the same refusal, sized for a 132px slot.
  if (isTrendBaseline(points)) {
    const y = padding + plotHeight / 2
    return (
      <svg
        className={`sparkline sparkline-${tone} sparkline-baseline`}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        {points.map((_, index) => <circle key={index} cx={xOf(index)} cy={y} r="1.5" />)}
      </svg>
    )
  }

  const min = Math.min(...points)
  const max = Math.max(...points)
  // Centre the series inside the floor span, so a small move sits in the middle
  // of the box rather than being stretched across it.
  const span = Math.max(max - min, MIN_SPAN)
  const low = (max + min) / 2 - span / 2
  const coordinates = points
    .map((point, index) => `${xOf(index)},${padding + (1 - (point - low) / span) * plotHeight}`)
    .join(' ')

  return (
    <svg className={`sparkline sparkline-${tone}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x={padding} y={padding} width={innerWidth} height={innerHeight} rx="8" />
        </clipPath>
      </defs>
      <line className="sparkline-guide" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
      <polyline clipPath={`url(#${clipId})`} points={coordinates} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
