'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { AGENT_LABELS, USAGE_RANGES, type UsageRange, type UsageResponse, type UsageTotals } from '@valet/shared'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { errorMessage } from '@/lib/api'
import { relativeTime, tokens, usd } from '@/lib/format'
import { useUsage } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { UsageChart } from '@/components/usage/usage-chart'

const RANGE_LABELS: Record<UsageRange, string> = { '7d': '7 days', '30d': '30 days', all: 'All' }
const METRICS = ['cost', 'tokens'] as const
type Metric = (typeof METRICS)[number]
const METRIC_LABELS: Record<Metric, string> = { cost: 'Cost', tokens: 'Tokens' }
const WINDOW_LABELS: Record<string, string> = { five_hour: '5 hour', seven_day: '7 day' }

type SortKey = 'costUsd' | 'inputTokens' | 'outputTokens' | 'turns' | 'threads'
type Sort = { key: SortKey; dir: 'asc' | 'desc' }

/** Cost is the default because it is what the tables are read for. */
function useSort(): [Sort, (key: SortKey) => void] {
  const [sort, setSort] = useState<Sort>({ key: 'costUsd', dir: 'desc' })
  return [sort, (key) => setSort((s) => (s.key === key ? { ...s, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))]
}

/** Groups with no cost data sort last whichever way the column points, then by turns. */
function sorted<T extends UsageTotals>(rows: T[], sort: Sort): T[] {
  const sign = sort.dir === 'desc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[sort.key]
    const y = b[sort.key]
    const untracked = (x === null ? 1 : 0) - (y === null ? 1 : 0)
    return untracked || sign * ((y ?? 0) - (x ?? 0)) || b.turns - a.turns
  })
}

export function UsageView() {
  const [range, setRange] = useState<UsageRange>('7d')
  const { data, error } = useUsage(range)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-medium">Usage</h1>
          <Tabs
            options={USAGE_RANGES.map((r) => ({ id: r, label: RANGE_LABELS[r] }))}
            value={range}
            onChange={setRange}
            label="Range"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(error)}
          </p>
        )}
        {!error && <Summary totals={data?.totals ?? null} />}
        {data && data.totals.turns > 0 && (
          <>
            <Daily days={data.daily} bucket={data.bucket} />
            <Rollup
              title="By project"
              head="Project"
              rows={data.byProject}
              id={(r) => r.projectId}
              cell={(r) => (
                <Link href={`/projects/${r.projectId}`} title={r.projectName} className="block truncate font-medium hover:underline">
                  {r.projectName}
                </Link>
              )}
            />
            <Rollup
              title="By model"
              head="Model"
              rows={data.byModel}
              id={(r) => `${r.agent}/${r.model}`}
              cell={(r) => (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-medium">{AGENT_LABELS[r.agent]}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{r.model}</span>
                </span>
              )}
            />
          </>
        )}
        {data && data.rateLimits.length > 0 && <RateLimits limits={data.rateLimits} />}
      </div>
    </div>
  )
}

function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ id: T; label: string }>
  value: T
  onChange: (id: T) => void
  label: string
}) {
  return (
    <div className="flex gap-1" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          type="button"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-md px-2 py-1 text-xs',
            value === o.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Summary({ totals }: { totals: UsageTotals | null }) {
  const stats: Array<{ label: string; value: string | null }> = [
    { label: 'Cost', value: totals && usd(totals.costUsd) },
    { label: 'Input tokens', value: totals && tokens(totals.inputTokens) },
    { label: 'Output tokens', value: totals && tokens(totals.outputTokens) },
    { label: 'Turns', value: totals && String(totals.turns) },
    { label: 'Threads', value: totals && String(totals.threads) },
  ]
  return (
    <dl className="grid grid-cols-5 gap-4">
      {stats.map((s) => (
        <div key={s.label} className="flex flex-col gap-1">
          <dt className="text-xs whitespace-nowrap text-muted-foreground">{s.label}</dt>
          <dd className="text-lg font-medium tabular-nums">{totals ? (s.value ?? '—') : <Skeleton className="h-7 w-16" />}</dd>
        </div>
      ))}
    </dl>
  )
}

function Daily({ days, bucket }: { days: UsageResponse['daily']; bucket: UsageResponse['bucket'] }) {
  const [metric, setMetric] = useState<Metric>('cost')
  const values = days.map((d) => (metric === 'cost' ? (d.costUsd ?? 0) : d.inputTokens + d.outputTokens))
  const max = Math.max(...values, 0)
  const peak = metric === 'cost' ? (usd(max) ?? '$0.00') : tokens(max)

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{bucket === 'week' ? 'Weekly' : 'Daily'}</h2>
        <Tabs
          options={METRICS.map((m) => ({ id: m, label: METRIC_LABELS[m] }))}
          value={metric}
          onChange={setMetric}
          label="Metric"
        />
      </div>
      <UsageChart days={days} values={values} max={max} peak={peak} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{bucket === 'week' ? 'Week (UTC)' : 'Day (UTC)'}</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
            <TableHead className="text-right">Turns</TableHead>
            <TableHead className="text-right">Threads</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map((d) => (
            <TableRow key={d.day}>
              <TableCell className="font-mono text-xs">{d.day}</TableCell>
              <Numbers totals={d} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

function Rollup<T extends UsageTotals>({
  title,
  head,
  rows,
  id,
  cell,
}: {
  title: string
  head: string
  rows: T[]
  id: (row: T) => string
  cell: (row: T) => ReactNode
}) {
  const [sort, toggle] = useSort()
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{head}</TableHead>
            <SortHead label="Cost" sortKey="costUsd" sort={sort} onSort={toggle} />
            <SortHead label="Input" sortKey="inputTokens" sort={sort} onSort={toggle} />
            <SortHead label="Output" sortKey="outputTokens" sort={sort} onSort={toggle} />
            <SortHead label="Turns" sortKey="turns" sort={sort} onSort={toggle} />
            <SortHead label="Threads" sortKey="threads" sort={sort} onSort={toggle} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted(rows, sort).map((row) => (
            <TableRow key={id(row)}>
              <TableCell className="max-w-64">{cell(row)}</TableCell>
              <Numbers totals={row} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

function SortHead({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: Sort; onSort: (key: SortKey) => void }) {
  const active = sort.key === sortKey
  return (
    <TableHead className="text-right" aria-sort={active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn('inline-flex items-center gap-1', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
      >
        {label}
        {active && (sort.dir === 'desc' ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" />)}
      </button>
    </TableHead>
  )
}

/** The five numeric cells every rollup row shares. */
function Numbers({ totals }: { totals: UsageTotals }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{usd(totals.costUsd) ?? '—'}</TableCell>
      <TableCell className="text-right tabular-nums">{tokens(totals.inputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{tokens(totals.outputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.turns}</TableCell>
      <TableCell className="text-right tabular-nums">{totals.threads}</TableCell>
    </>
  )
}

function RateLimits({ limits }: { limits: UsageResponse['rateLimits'] }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">Rate limits</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Window</TableHead>
            <TableHead className="text-right">Utilization</TableHead>
            <TableHead className="text-right">Resets</TableHead>
            <TableHead className="text-right">Observed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {limits.map((limit) => {
            const percent = Math.round(limit.utilization * 100)
            return (
              <TableRow key={`${limit.agent}/${limit.window}`}>
                <TableCell className="font-medium">{AGENT_LABELS[limit.agent]}</TableCell>
                <TableCell>{WINDOW_LABELS[limit.window] ?? limit.window}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    <span aria-hidden className="h-1 w-24 bg-muted">
                      <span className="block h-1 bg-foreground" style={{ width: `${Math.min(100, percent)}%` }} />
                    </span>
                    <span className="w-10 text-right tabular-nums">{percent}%</span>
                  </div>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {limit.resetsAt ? relativeTime(limit.resetsAt) : '—'}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{relativeTime(limit.observedAt)}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}
