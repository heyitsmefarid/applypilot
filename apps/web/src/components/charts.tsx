import { Table2 } from 'lucide-react';
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/utils';
import { Panel } from './ui/display';

/**
 * Chart conventions: one y-axis, recessive grid/axes, thin marks with 4px rounded data ends,
 * hover tooltips, a legend whenever there are 2+ series, and a table view for every chart.
 * Series colors come from validated tokens (--chart-1, --chart-2).
 */

export interface Series {
  key: string;
  label: string;
  color: string;
}

const axis = { stroke: 'var(--muted)', fontSize: 11, tickLine: false, axisLine: false } as const;

function ChartTooltip({ active, payload, label, series }: { active?: boolean; payload?: Array<{ dataKey: string; value: number }>; label?: string; series: Series[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-2 text-xs shadow-[0_8px_24px_-10px_rgba(12,17,23,0.35)]">
      <p className="mb-1 font-semibold text-ink">{label}</p>
      {payload.map((p) => {
        const s = series.find((x) => x.key === p.dataKey);
        return (
          <p key={p.dataKey} className="flex items-center gap-2 text-ink-2">
            <span className="size-2 rounded-sm" style={{ background: s?.color }} aria-hidden />
            {s?.label ?? p.dataKey}
            <span className="figures ml-auto pl-3 font-semibold text-ink">{p.value}</span>
          </p>
        );
      })}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-ink-2">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ data, xKey, xLabel, series }: { data: Array<Record<string, string | number>>; xKey: string; xLabel: string; series: Series[] }) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-line text-muted">
            <th className="py-1.5 pr-3 font-medium">{xLabel}</th>
            {series.map((s) => (
              <th key={s.key} className="py-1.5 pr-3 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-b border-line/60">
              <td className="py-1.5 pr-3">{row[xKey]}</td>
              {series.map((s) => (
                <td key={s.key} className="figures py-1.5 pr-3 text-right">
                  {row[s.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartPanel({
  title,
  description,
  kind,
  data,
  xKey,
  xLabel,
  series,
  height = 220,
  layout = 'vertical',
  emptyText = 'No data yet.',
  className,
  colorFor,
}: {
  title: string;
  description?: string;
  kind: 'bar' | 'line';
  data: Array<Record<string, string | number>>;
  xKey: string;
  xLabel: string;
  series: Series[];
  height?: number;
  /** "horizontal" draws category bars left-to-right (long labels). */
  layout?: 'vertical' | 'horizontal';
  emptyText?: string;
  className?: string;
  colorFor?: (row: Record<string, string | number>) => string;
}) {
  const [table, setTable] = React.useState(false);
  const empty = !data.length || data.every((d) => series.every((s) => !Number(d[s.key])));
  return (
    <Panel
      title={title}
      description={description}
      className={className}
      actions={
        <button onClick={() => setTable((t) => !t)} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-ink', table && 'text-ink')} aria-pressed={table}>
          <Table2 className="size-3.5" /> {table ? 'Chart' : 'Table'}
        </button>
      }
    >
      {empty ? (
        <p className="py-10 text-center text-[13px] text-muted">{emptyText}</p>
      ) : table ? (
        <DataTable data={data} xKey={xKey} xLabel={xLabel} series={series} />
      ) : (
        <div className="grid gap-2">
          <Legend series={series} />
          <div style={{ height }} role="img" aria-label={`${title} chart. Use the Table button for the data.`}>
            <ResponsiveContainer width="100%" height="100%">
              {kind === 'bar' ? (
                layout === 'horizontal' ? (
                  <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }} barCategoryGap={6}>
                    <CartesianGrid horizontal={false} stroke="var(--line)" strokeDasharray="0" />
                    <XAxis type="number" allowDecimals={false} {...axis} />
                    <YAxis type="category" dataKey={xKey} width={132} interval={0} {...axis} tick={{ fill: 'var(--ink-2)', fontSize: 11 }} />
                    <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<ChartTooltip series={series} />} />
                    {series.map((s) => (
                      <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[0, 4, 4, 0]} maxBarSize={16}>
                        {colorFor && data.map((row, i) => <Cell key={i} fill={colorFor(row)} />)}
                      </Bar>
                    ))}
                  </BarChart>
                ) : (
                  <BarChart data={data} margin={{ left: -16, right: 4, top: 4, bottom: 0 }} barGap={2}>
                    <CartesianGrid vertical={false} stroke="var(--line)" />
                    <XAxis dataKey={xKey} {...axis} interval="preserveStartEnd" minTickGap={12} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<ChartTooltip series={series} />} />
                    {series.map((s) => (
                      <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    ))}
                  </BarChart>
                )
              ) : (
                <LineChart data={data} margin={{ left: -16, right: 8, top: 6, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--line)" />
                  <XAxis dataKey={xKey} {...axis} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis allowDecimals={false} {...axis} />
                  <Tooltip cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }} content={<ChartTooltip series={series} />} />
                  {series.map((s) => (
                    <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Panel>
  );
}

export const CHART_1 = 'var(--chart-1)';
export const CHART_2 = 'var(--chart-2)';

/** Buckets ISO timestamps into the last `days` calendar days (Asia/Manila). */
export function dailyBuckets<T>(rows: T[], getDate: (r: T) => string | null | undefined, days: number, keyName = 'count') {
  const fmt = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
  const dayKey = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const out = new Map<string, { label: string; value: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    out.set(dayKey(d), { label: fmt.format(d), value: 0 });
  }
  for (const r of rows) {
    const iso = getDate(r);
    if (!iso) continue;
    const b = out.get(dayKey(new Date(iso)));
    if (b) b.value++;
  }
  return [...out.values()].map((b) => ({ day: b.label, [keyName]: b.value }));
}
