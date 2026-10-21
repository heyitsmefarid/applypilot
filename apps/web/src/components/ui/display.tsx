import { Tabs as TabsPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'jade' | 'amber' | 'rose' | 'sky' | 'outline';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  jade: 'bg-jade-soft text-jade',
  amber: 'bg-amber-soft text-amber',
  rose: 'bg-rose-soft text-rose',
  sky: 'bg-sky-soft text-sky',
  outline: 'border border-line-strong text-ink-2',
};

export function Badge({ tone = 'neutral', className, children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium [&_svg]:size-3', tones[tone], className)} {...props}>
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-surface-2', className)} aria-hidden />;
}

/** The base surface. `title` renders a compact header row; `actions` sit on its right. */
export function Panel({ title, description, actions, children, className, bodyClassName, as: As = 'section' }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode; className?: string; bodyClassName?: string; as?: 'section' | 'div' }) {
  return (
    <As className={cn('min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[14px] font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </As>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: React.ComponentType<{ className?: string }>; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[var(--radius-panel)] border border-dashed border-line-strong px-5 py-8">
      {Icon && <Icon className="size-5 text-muted" />}
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {children && <div className="max-w-prose text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="type-display text-[26px]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-rose/30 bg-rose-soft px-3 py-2 text-[13px] text-rose">
      <span>{error instanceof Error ? error.message : String(error)}</span>
      {retry && (
        <button className="font-medium underline underline-offset-2" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('inline-flex items-center gap-1 border-b border-line', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn('-mb-px border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-muted hover:text-ink data-[state=active]:border-jade data-[state=active]:text-ink', className)}
      {...props}
    />
  );
}
export const TabsContent = TabsPrimitive.Content;

/** Thin horizontal meter with an accessible value. */
export function Meter({ value, max = 100, tone = 'jade', label }: { value: number; max?: number; tone?: 'jade' | 'amber' | 'rose' | 'sky'; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = { jade: 'bg-jade', amber: 'bg-amber', rose: 'bg-rose', sky: 'bg-sky' }[tone];
  return (
    <div role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}
