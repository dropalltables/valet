'use client'

import type { UsageDay } from '@valet/shared'

const HEIGHT = 100
/**
 * The viewBox width is fixed so a unit maps to the same number of pixels whatever the
 * range is: 7 bars stay bar-shaped instead of stretching into blocks across the pane.
 */
const WIDTH = 300
const MAX_BAR = 12

/**
 * The daily table below carries the same numbers, so the bars stay out of the
 * accessibility tree. Nothing inside the SVG is text, which is what makes the
 * non-uniform scale of `preserveAspectRatio="none"` safe.
 */
export function UsageChart({ days, values, max, peak }: { days: UsageDay[]; values: number[]; max: number; peak: string }) {
  const slot = WIDTH / days.length
  const bar = Math.min(slot * 0.7, MAX_BAR)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground tabular-nums">{peak}</span>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT + 1}`} preserveAspectRatio="none" className="h-24 w-full" aria-hidden="true">
        {values.map((value, i) => {
          // A day with any activity keeps a visible sliver rather than rounding to nothing.
          const height = value > 0 ? Math.max(1, (value / max) * HEIGHT) : 0
          return (
            <rect
              key={days[i]?.day}
              x={i * slot + (slot - bar) / 2}
              y={HEIGHT - height}
              width={bar}
              height={height}
              className="fill-foreground"
            />
          )
        })}
        <line x1={0} y1={HEIGHT + 0.5} x2={WIDTH} y2={HEIGHT + 0.5} className="stroke-border" />
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{days[0]?.day}</span>
        {days.length > 1 && <span>{days[days.length - 1]?.day}</span>}
      </div>
    </div>
  )
}
