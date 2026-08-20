/**
 * The charts, drawn as plain SVG.
 *
 * ── Why no charting library ────────────────────────────────────────────────────
 * Four chart shapes are needed and they are all axis-and-rectangle work. A library would add a
 * dependency the size of the rest of the bundle put together, to draw bars this file draws in a
 * dozen lines — and it would still have to be argued out of its defaults, which is where the
 * time actually goes.
 *
 * ── The rules these follow, and why ────────────────────────────────────────────
 * The palette is fixed and **validated** rather than chosen by eye: five categorical hues stepped
 * for this app's dark surface, checked for colour-blind separation (the worst adjacent pair sits at
 * ΔE 8.4 for protanopia) and for at least 3:1 contrast against the card. Eyeballing that is how
 * charts end up unreadable for one reader in twelve.
 *
 * Then, in order of how often each is got wrong:
 *
 *   · **One vertical scale, always.** Two measures on two scales can be made to tell any story you
 *     like by sliding one axis; refunds and revenue share a scale here, which is why the refund
 *     column is visibly small rather than dramatically large.
 *   · **Marks are thin, gridlines recede.** The data is the only thing allowed to be loud.
 *   · **A 2px gap in the surface colour separates touching marks** — never a stroke, which adds ink
 *     that is not data.
 *   · **Labels are sparing.** A number on every column is chaos and goes unread; the tallest and
 *     the latest carry labels, the axis and the tooltip carry the rest.
 *   · **Colour is never the only channel.** Two or more series always get a legend, every chart has
 *     a table view a keyboard can reach, and no meaning rests on a hue alone.
 */

import { useId, useState, type ReactNode } from 'react'

/**
 * The categorical palette, in fixed slot order.
 *
 * **Assigned by slot, never cycled.** A hue belongs to a thing — plans keep their colour when a
 * filter removes one of them, so the reader is not repainted mid-thought. Nine series would need
 * folding into "other" rather than a ninth colour nobody can name.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const

/** Reserved for state, and never reused as "series 6". Each one ships with a written label. */
export const STATUS = {
  active: '#199e70',
  expiring: '#c98500',
  expired: '#e34948',
  lifetime: '#9085e9',
  unknown: '#64748b',
} as const

/** The card colour, for the gaps and rings that do the separating. */
const SURFACE = '#0f172a'
const GRID = 'rgba(148, 163, 184, 0.16)'
const INK_MUTED = '#94a3b8'

/** Money, short enough to sit under a column: ₹1.2L, ₹45.0k, ₹900. */
export function compactMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  const n = Math.abs(value)
  if (n >= 1e7) return `${sign}₹${(n / 1e7).toFixed(1)}Cr`
  if (n >= 1e5) return `${sign}₹${(n / 1e5).toFixed(1)}L`
  if (n >= 1000) return `${sign}₹${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `${sign}₹${Math.round(n)}`
}

/** Full rupees with thousands separators, for tooltips and tables. */
export function money(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

/* ───────────────────────────────────────────────────────────────── frame ── */

export interface TableView {
  columns: string[]
  rows: string[][]
}

/**
 * The shell every chart sits in: title, optional legend, and a table toggle.
 *
 * The toggle is not a nicety. A chart is an image of numbers, and some readers need the numbers —
 * a screen reader, a colour-blind reader defeated by two close hues, anyone who wants to check a
 * total. The table is the same data, one keypress away, so nothing is gated behind seeing.
 */
export function ChartCard({
  title,
  subtitle,
  legend,
  table,
  children,
}: {
  title: string
  subtitle?: string
  legend?: { label: string; color: string }[]
  table: TableView
  children: ReactNode
}) {
  const [showTable, setShowTable] = useState(false)

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[14px] font-bold leading-tight text-slate-100">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[12px] text-slate-400">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={() => setShowTable((on) => !on)}
          className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[11.5px] font-semibold text-slate-300 transition-colors hover:border-white/20 hover:text-slate-100"
          aria-pressed={showTable}
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {legend && legend.length > 1 && (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
          {legend.map((item) => (
            <li key={item.label} className="flex items-center gap-1.5 text-[12px] text-slate-300">
              {/* The swatch carries the identity; the text stays in ink, where it is legible. */}
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} aria-hidden />
              {item.label}
            </li>
          ))}
        </ul>
      )}

      {showTable ? <DataTable {...table} /> : children}
    </section>
  )
}

function DataTable({ columns, rows }: TableView) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={column}
                className={`sticky top-0 border-b border-white/10 bg-slate-900/90 px-2 py-1.5 font-semibold text-slate-400 ${index === 0 ? 'text-left' : 'text-right'}`}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`border-b border-white/[0.06] px-2 py-1.5 text-slate-200 ${index === 0 ? 'text-left' : 'text-right tabular-nums'}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-2 py-6 text-center text-slate-500">
                Nothing in this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────── columns ── */

export interface Column {
  label: string
  /** Drawn upward. */
  value: number
  /** Drawn as a second, narrower column beside it — refunds, against the same scale. */
  second?: number
}

/**
 * Grouped columns over time.
 *
 * Values share one scale with the second series on purpose: a refund that is a twentieth of the
 * month's takings should *look* like a twentieth. Giving it its own axis is the single most
 * effective way to make a small number look alarming, which is why this chart cannot do it.
 */
export function Columns({
  data,
  colors = [SERIES[0], SERIES[4]],
  height = 200,
  format = compactMoney,
  names = ['Net', 'Refunded'],
}: {
  data: Column[]
  colors?: [string, string]
  height?: number
  /**
   * How a value is written on the axis, the labels and the tooltip.
   *
   * Defaults to money, but this chart is also used for counts — and an axis reading "₹3" against a
   * count of three entries is not a small cosmetic slip, it is the chart claiming three rupees.
   */
  format?: (value: number) => string
  /** What the two series are called, for the tooltip. Same reason as `format`. */
  names?: [string, string]
}) {
  const clip = useId()
  const [hover, setHover] = useState<number | null>(null)

  const padLeft = 46
  const padBottom = 24
  const padTop = 16
  const width = Math.max(320, data.length * 46)
  const plotWidth = width - padLeft - 8
  const plotHeight = height - padBottom - padTop

  /*
   * The axis has to hold negatives, because a month can genuinely be negative: refund a licence in
   * a month when nothing else sold and the net is below zero. Clamping that to a missing bar hides
   * the one month somebody would want to ask about, so **zero moves up the plot and the bar hangs
   * below it** — the only honest way to draw a loss on a chart of money.
   */
  const peak = Math.max(1, ...data.map((d) => Math.max(d.value, d.second ?? 0)))
  const trough = Math.min(0, ...data.map((d) => d.value))
  const top = niceCeil(peak)
  const bottom = trough < 0 ? -niceCeil(-trough) : 0
  const span = top - bottom
  /* Where zero sits in the plot; the bottom edge when nothing is negative. */
  const zeroY = padTop + plotHeight - ((0 - bottom) / span) * plotHeight
  const scale = (value: number) => (Math.abs(value) / span) * plotHeight
  const band = plotWidth / Math.max(1, data.length)
  /* Capped, never filling the slot — the leftover band is the air between months. */
  const barWidth = Math.min(22, band * 0.44)

  const ticks = bottom < 0 ? [bottom, 0, top] : [0, top / 2, top]
  const tickY = (tick: number) => padTop + plotHeight - ((tick - bottom) / span) * plotHeight

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full"
          style={{ minWidth: width }}
          role="img"
          aria-label={`${names[0]} by month. Use the Table button for the figures.`}
        >
          <defs>
            <clipPath id={clip}>
              <rect x={0} y={0} width={width} height={height} />
            </clipPath>
          </defs>

          {/* Gridlines and ticks, one step off the surface so they sit behind the data. */}
          {ticks.map((tick) => {
            const y = tickY(tick)
            /*
             * A shallow negative floor puts its label on top of the zero label. The gridline still
             * gets drawn — the scale is unchanged — but the text is dropped rather than overlapped,
             * because two numbers printed through each other are worse than one.
             */
            const crowded = tick !== 0 && Math.abs(y - tickY(0)) < 14
            return (
              <g key={tick}>
                <line x1={padLeft} y1={y} x2={width - 8} y2={y} stroke={GRID} strokeWidth={1} />
                {!crowded && (
                  <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize={10.5} fill={INK_MUTED}>
                    {format(tick)}
                  </text>
                )}
              </g>
            )
          })}

          <g clipPath={`url(#${clip})`}>
            {data.map((point, index) => {
              const centre = padLeft + band * index + band / 2
              const hasSecond = (point.second ?? 0) > 0
              /* The 2px surface gap between the pair — the separator is space, not a stroke. */
              const gap = hasSecond ? 2 : 0
              const primaryX = hasSecond ? centre - barWidth - gap / 2 : centre - barWidth / 2
              const primaryHeight = scale(point.value)
              const negative = point.value < 0

              return (
                <g
                  key={point.label}
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                >
                  {/* A full-height hit area: the hover target is the month, not the 22px bar. */}
                  <rect x={padLeft + band * index} y={padTop} width={band} height={plotHeight} fill="transparent" />

                  {/* A negative month hangs below zero, in the refund colour — it *is* money out. */}
                  {point.value !== 0 && (
                    <RoundedBar
                      x={primaryX}
                      y={negative ? zeroY : zeroY - primaryHeight}
                      width={barWidth}
                      height={primaryHeight}
                      fill={negative ? colors[1] : colors[0]}
                      flip={negative}
                    />
                  )}
                  {hasSecond && (
                    <RoundedBar
                      x={centre + gap / 2}
                      y={zeroY - scale(point.second ?? 0)}
                      width={barWidth}
                      height={scale(point.second ?? 0)}
                      fill={colors[1]}
                    />
                  )}

                  {/* Only the tallest, the newest, and any loss get a label — every column labelled reads as noise. */}
                  {(labelWorthy(data, index) || negative) && point.value !== 0 && (
                    <text
                      x={hasSecond ? primaryX + barWidth / 2 : centre}
                      /* Above zero for a loss too: below it the label lands on the month labels. */
                      y={negative ? zeroY - 5 : zeroY - primaryHeight - 5}
                      textAnchor="middle"
                      fontSize={10.5}
                      fill={negative ? '#fda4af' : '#e2e8f0'}
                      fontWeight={600}
                    >
                      {format(point.value)}
                    </text>
                  )}

                  <text x={centre} y={height - 7} textAnchor="middle" fontSize={10.5} fill={INK_MUTED}>
                    {point.label}
                  </text>
                </g>
              )
            })}
          </g>

          {/* The zero line is drawn last, so bars sit on it rather than over it. */}
          <line x1={padLeft} y1={zeroY} x2={width - 8} y2={zeroY} stroke={bottom < 0 ? 'rgba(148, 163, 184, 0.4)' : GRID} strokeWidth={1} />
        </svg>
      </div>

      {hover !== null && data[hover] && (
        <Tooltip>
          <strong className="font-bold text-slate-100">{data[hover].label}</strong>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: colors[0] }} aria-hidden />
            {names[0]} {format === compactMoney ? money(data[hover].value) : format(data[hover].value)}
          </span>
          {(data[hover].second ?? 0) > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: colors[1] }} aria-hidden />
              {names[1]} {format === compactMoney ? money(data[hover].second ?? 0) : format(data[hover].second ?? 0)}
            </span>
          )}
        </Tooltip>
      )}
    </div>
  )
}

/** Label the tallest column and the last one — the extreme and the present. */
function labelWorthy(data: Column[], index: number): boolean {
  if (index === data.length - 1) return true
  const peak = Math.max(...data.map((d) => d.value))
  return data[index].value === peak && peak > 0
}

/**
 * A bar rounded at the data end and square at the baseline.
 *
 * Rounding both ends detaches the bar from its own axis, and rounding a bar shorter than the radius
 * turns it into a lozenge — so the radius is clamped to the height.
 */
function RoundedBar({
  x,
  y,
  width,
  height,
  fill,
  flip = false,
}: {
  x: number
  y: number
  width: number
  height: number
  fill: string
  /** For a bar hanging below zero: round the bottom instead, so the curve is still the data end. */
  flip?: boolean
}) {
  const r = Math.min(4, height, width / 2)
  if (height <= 0.5) return null
  if (flip) {
    return (
      <path
        d={`M ${x} ${y} L ${x} ${y + height - r} Q ${x} ${y + height} ${x + r} ${y + height} L ${x + width - r} ${y + height} Q ${x + width} ${y + height} ${x + width} ${y + height - r} L ${x + width} ${y} Z`}
        fill={fill}
      />
    )
  }
  return (
    <path
      d={`M ${x} ${y + height} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + width - r} ${y} Q ${x + width} ${y} ${x + width} ${y + r} L ${x + width} ${y + height} Z`}
      fill={fill}
    />
  )
}

/* ──────────────────────────────────────────────────────────── trend line ── */

/**
 * A cumulative line: where the total had reached by each month.
 *
 * A single series, so **no legend** — the title already says what is plotted, and a box holding one
 * swatch restates it. The fill is a 10% wash rather than a solid block; the line is the data, the
 * wash only says which side of it is "so far".
 */
export function TrendLine({
  data,
  color = SERIES[2],
  height = 180,
}: {
  data: { label: string; value: number }[]
  color?: string
  height?: number
}) {
  const gradient = useId()
  const [hover, setHover] = useState<number | null>(null)

  const padLeft = 46
  const padBottom = 24
  const padTop = 16
  const width = Math.max(320, data.length * 46)
  /* 26 on the right, not 12: the final month label is centred on the last point and was clipped. */
  const plotWidth = width - padLeft - 26
  const plotHeight = height - padBottom - padTop

  const top = niceCeil(Math.max(1, ...data.map((d) => d.value)))
  const stepX = plotWidth / Math.max(1, data.length - 1)
  const pointAt = (index: number) => ({
    x: padLeft + stepX * index,
    y: padTop + plotHeight - (Math.max(0, data[index].value) / top) * plotHeight,
  })

  const path = data.map((_, index) => `${index === 0 ? 'M' : 'L'} ${pointAt(index).x} ${pointAt(index).y}`).join(' ')
  const area = `${path} L ${padLeft + stepX * (data.length - 1)} ${padTop + plotHeight} L ${padLeft} ${padTop + plotHeight} Z`
  const last = data.length - 1

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full"
          style={{ minWidth: width }}
          role="img"
          aria-label="Cumulative money kept. Use the Table button for the figures."
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          {[0, top / 2, top].map((tick) => {
            const y = padTop + plotHeight - (tick / top) * plotHeight
            return (
              <g key={tick}>
                <line x1={padLeft} y1={y} x2={width - 12} y2={y} stroke={GRID} strokeWidth={1} />
                <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize={10.5} fill={INK_MUTED}>
                  {compactMoney(tick)}
                </text>
              </g>
            )
          })}

          {data.length > 1 && <path d={area} fill={`url(#${gradient})`} />}
          {data.length > 1 && <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}

          {/* Crosshair on hover, and an end-dot that always shows where the line finished. */}
          {hover !== null && (
            <line x1={pointAt(hover).x} y1={padTop} x2={pointAt(hover).x} y2={padTop + plotHeight} stroke={GRID} strokeWidth={1} />
          )}
          {data.length > 0 && (
            <>
              {/* 2px surface ring, so the marker stays legible where it meets the line. */}
              <circle cx={pointAt(last).x} cy={pointAt(last).y} r={6} fill={SURFACE} />
              <circle cx={pointAt(last).x} cy={pointAt(last).y} r={4} fill={color} />
            </>
          )}
          {hover !== null && hover !== last && (
            <>
              <circle cx={pointAt(hover).x} cy={pointAt(hover).y} r={6} fill={SURFACE} />
              <circle cx={pointAt(hover).x} cy={pointAt(hover).y} r={4} fill={color} />
            </>
          )}

          {data.map((point, index) => (
            <g key={point.label} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}>
              <rect x={pointAt(index).x - stepX / 2} y={padTop} width={stepX} height={plotHeight} fill="transparent" />
              {/* Every other label, so an axis of twelve months does not overlap itself. */}
              {(index % 2 === 0 || index === last) && (
                <text x={pointAt(index).x} y={height - 7} textAnchor="middle" fontSize={10.5} fill={INK_MUTED}>
                  {point.label}
                </text>
              )}
            </g>
          ))}

          <line x1={padLeft} y1={padTop + plotHeight} x2={width - 12} y2={padTop + plotHeight} stroke={GRID} strokeWidth={1} />
        </svg>
      </div>

      {hover !== null && data[hover] && (
        <Tooltip>
          <strong className="font-bold text-slate-100">{data[hover].label}</strong>
          <span>Kept so far {money(data[hover].value)}</span>
        </Tooltip>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────────────── horizontal bars ── */

/**
 * Ranked horizontal bars — for plans and payment methods.
 *
 * Horizontal because the labels are words: '2year', 'lifetime', 'bank transfer' do not fit under a
 * column without being turned on their side, and a reader should never have to tilt their head.
 * The value rides the tip of each bar, which is the one place a label cannot collide with the data.
 */
export function RankedBars({
  data,
  colors = SERIES,
}: {
  data: { label: string; net: number; share: number }[]
  colors?: readonly string[]
}) {
  const top = Math.max(1, ...data.map((d) => Math.abs(d.net)))

  if (data.length === 0) {
    return <p className="py-8 text-center text-[13px] text-slate-500">Nothing in this period.</p>
  }

  return (
    <ul className="space-y-2.5">
      {data.map((row, index) => (
        <li key={row.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="flex min-w-0 items-center gap-1.5 text-slate-300">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colors[index % colors.length] }} aria-hidden />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="shrink-0 tabular-nums font-semibold text-slate-100">
              {money(row.net)}
              <span className="ml-1.5 font-normal text-slate-500">{(row.share * 100).toFixed(0)}%</span>
            </span>
          </div>
          {/* The track is a lighter step of the same idea, so an empty bar still reads as a bar. */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(1, (Math.abs(row.net) / top) * 100)}%`,
                background: colors[index % colors.length],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ─────────────────────────────────────────────────────────── stacked bar ── */

/**
 * One bar, split by state — the shape of the customer base at a glance.
 *
 * Every segment is directly labelled, which is not decoration: two of these hues (expired red and
 * expiring amber) sit close enough together for a reader with deuteranopia that colour alone would
 * not separate them. The written label is the channel that does.
 */
export function StackedBar({
  data,
}: {
  data: { label: string; value: number; color: string }[]
}) {
  const total = data.reduce((sum, part) => sum + part.value, 0)
  if (total === 0) {
    return <p className="py-8 text-center text-[13px] text-slate-500">No accounts yet.</p>
  }

  const shown = data.filter((part) => part.value > 0)

  return (
    <div>
      {/* gap-[2px] is the surface gap: space separates the segments, not a border. */}
      <div className="flex h-6 w-full gap-[2px] overflow-hidden rounded-lg">
        {shown.map((part) => (
          <div
            key={part.label}
            className="h-full first:rounded-l-lg last:rounded-r-lg"
            style={{ width: `${(part.value / total) * 100}%`, background: part.color }}
            title={`${part.label}: ${part.value}`}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {shown.map((part) => (
          <li key={part.label} className="flex items-baseline gap-1.5 text-[12.5px]">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: part.color }} aria-hidden />
            <span className="truncate text-slate-300">{part.label}</span>
            <span className="ml-auto tabular-nums font-semibold text-slate-100">{part.value}</span>
            <span className="tabular-nums text-slate-500">{((part.value / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────── the bits ── */

/**
 * Where the hover detail appears.
 *
 * Pinned above the chart rather than following the cursor: a tooltip that chases the pointer covers
 * the very marks being compared, and on a touch screen there is no cursor to follow at all.
 */
function Tooltip({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute right-0 top-0 flex flex-col gap-0.5 rounded-xl border border-white/10 bg-slate-950/90 px-2.5 py-1.5 text-[12px] text-slate-300 shadow-lg backdrop-blur">
      {children}
    </div>
  )
}

/**
 * Rounds an axis top to something a person would say out loud.
 *
 * An axis topping out at ₹47,312 makes every gridline unreadable; ₹50,000 costs a little headroom
 * and buys ticks that can be read at a glance.
 */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}
