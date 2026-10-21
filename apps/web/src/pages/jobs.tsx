import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS } from '@applypilot/core';
import { SOURCE_CATALOG } from '@applypilot/core/sources';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, FlaskConical, Link2, Radar, Search, SlidersHorizontal, Star } from 'lucide-react';
import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { JobRow } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { Checkbox, Field, Input, Label, NativeSelect, Textarea } from '@/components/ui/form';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/overlay';
import { useAction, useJobs, type JobFilters } from '@/hooks/data';
import { useJobActions } from '@/hooks/job-actions';
import { post } from '@/lib/api';
import { check, currentUserId, supabase } from '@/lib/supabase';
import { humanize, timeAgo } from '@/lib/utils';

const VIEWS = {
  all: { title: 'Discover jobs', description: 'Every listing found by scheduled discovery, Gmail job alerts and your imports.', icon: Search },
  recommended: { title: 'Recommended jobs', description: 'Jobs that passed every mandatory eligibility rule, ranked by match score.', icon: Star },
  saved: { title: 'Saved jobs', description: 'Jobs you bookmarked to review or apply to later.', icon: Bookmark },
} as const;

function ImportJobDialog() {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState('');
  const [manual, setManual] = React.useState({ title: '', company: '', location: '', description: '' });
  const [manualMode, setManualMode] = React.useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const run = useAction(() => post<{ job_id: string | null; duplicate: boolean; note: string }>('/jobs/import-url', { url, ...(manual.title && manual.company ? manual : {}) }), {
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      setOpen(false);
      toast.success(r.duplicate ? 'You already have this job — opening it.' : 'Job imported', { description: r.note || undefined });
      if (r.job_id) navigate(`/jobs/${r.job_id}`);
    },
  });
  // Show manual fields once the page couldn't be read (and keep them while the user edits).
  const needsManual = manualMode || (run.error as { code?: string } | null)?.code === 'import_failed';
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Link2 /> Import job URL
        </Button>
      </DialogTrigger>
      <DialogContent title="Import a job from its URL" description="Works with company career pages and ATS postings that publish structured job data. LinkedIn and Indeed links are imported through their Gmail job alerts instead.">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (needsManual) setManualMode(true);
            run.mutate(undefined);
          }}
        >
          <Field label="Job posting URL">
            <Input type="url" required placeholder="https://careers.example.com/jobs/123" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          {needsManual && (
            <div className="grid gap-3 rounded-[var(--radius-control)] border border-amber/40 bg-amber-soft/50 p-3">
              <p className="text-xs text-amber">The page couldn't be read automatically. Enter the details yourself.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Job title">
                  <Input required value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} />
                </Field>
                <Field label="Company">
                  <Input required value={manual.company} onChange={(e) => setManual({ ...manual, company: e.target.value })} />
                </Field>
              </div>
              <Field label="Location">
                <Input value={manual.location} onChange={(e) => setManual({ ...manual, location: e.target.value })} />
              </Field>
              <Field label="Description">
                <Textarea rows={5} value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button type="submit" variant="primary" loading={run.isPending} disabled={!url}>
              Import job
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SearchHistory({ onPick }: { onPick: (q: string, filters: Partial<JobFilters>) => void }) {
  const { data = [] } = useQuery({
    queryKey: ['job-searches'],
    queryFn: async () => check(await supabase.from('job_searches').select('id, query, filters, result_count, created_at').order('created_at', { ascending: false }).limit(8), 'search history') as Array<{ id: string; query: string; filters: Partial<JobFilters>; result_count: number; created_at: string }>,
  });
  if (!data.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted">Recent searches</span>
      {data.map((s) => (
        <button key={s.id} className="rounded-full border border-line px-2 py-0.5 text-ink-2 hover:border-jade hover:text-jade" onClick={() => onPick(s.query, s.filters)} title={`${s.result_count} results, ${timeAgo(s.created_at)}`}>
          {s.query || 'Filters only'}
        </button>
      ))}
    </div>
  );
}

export default function Jobs({ view }: { view: 'all' | 'recommended' | 'saved' }) {
  const [params, setParams] = useSearchParams();
  const [showFilters, setShowFilters] = React.useState(false);
  const [draft, setDraft] = React.useState(params.get('q') ?? '');
  const filters: JobFilters = {
    view: params.get('hidden') === '1' ? 'hidden' : view,
    q: params.get('q') ?? undefined,
    arrangement: params.get('arrangement') ?? undefined,
    employment: params.get('employment') ?? undefined,
    level: params.get('level') ?? undefined,
    source: params.get('source') ?? undefined,
    company: params.get('company') ?? undefined,
    location: params.get('location') ?? undefined,
    maxAgeDays: params.get('age') ? Number(params.get('age')) : undefined,
    minScore: params.get('min') ? Number(params.get('min')) : view === 'recommended' ? 60 : undefined,
    salaryOnly: params.get('salary') === '1',
    includeExpired: params.get('expired') === '1',
  };
  const jobs = useJobs(filters);
  const actions = useJobActions();
  const meta = VIEWS[view];
  const discover = useAction(() => post('/automation/trigger', { workflow: 'job_discovery' }), { success: 'Discovery queued. New jobs appear here as n8n finds them.', invalidate: [['runs']] });
  const demo = useAction(() => post<{ job_id: string }>('/demo/job', {}), { success: 'Demo job created on the local test form', invalidate: [['jobs']] });

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const submitSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    set('q', draft.trim() || null);
    if (draft.trim()) {
      const { q: _q, view: _v, ...rest } = filters;
      await supabase.from('job_searches').insert({ user_id: await currentUserId(), query: draft.trim(), filters: rest, result_count: jobs.data?.length ?? 0 });
    }
  };

  const activeFilterCount = ['arrangement', 'employment', 'level', 'source', 'company', 'location', 'age', 'min', 'salary', 'expired', 'hidden'].filter((k) => params.get(k)).length;

  return (
    <>
      <PageHeader
        title={meta.title}
        description={meta.description}
        actions={
          view === 'all' && (
            <>
              <Button variant="ghost" onClick={() => demo.mutate(undefined)} loading={demo.isPending}>
                <FlaskConical /> Add demo job
              </Button>
              <ImportJobDialog />
              <Button variant="primary" onClick={() => discover.mutate(undefined)} loading={discover.isPending}>
                <Radar /> Run discovery
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-3">
        <form onSubmit={submitSearch} className="flex flex-wrap gap-2" role="search">
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted" aria-hidden />
            <Input aria-label="Search by position, skill or keyword" placeholder="Search by position, skill or keyword — e.g. react intern" className="pl-8" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </div>
          <Button type="submit">Search</Button>
          <Button type="button" variant={showFilters || activeFilterCount ? 'secondary' : 'ghost'} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <SlidersHorizontal /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </Button>
        </form>
        {view === 'all' && <SearchHistory onPick={(q) => { setDraft(q); set('q', q); }} />}
        {showFilters && (
          <Panel bodyClassName="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Work arrangement">
              <NativeSelect value={filters.arrangement ?? ''} onChange={(e) => set('arrangement', e.target.value || null)}>
                <option value="">Any</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
                <option value="onsite">Onsite</option>
              </NativeSelect>
            </Field>
            <Field label="Employment type">
              <NativeSelect value={filters.employment ?? ''} onChange={(e) => set('employment', e.target.value || null)}>
                <option value="">Any</option>
                {EMPLOYMENT_TYPES.filter((t) => t !== 'unknown').map((t) => (
                  <option key={t} value={t}>{humanize(t)}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Experience level">
              <NativeSelect value={filters.level ?? ''} onChange={(e) => set('level', e.target.value || null)}>
                <option value="">Any</option>
                {EXPERIENCE_LEVELS.filter((t) => t !== 'unknown').map((t) => (
                  <option key={t} value={t}>{t === 'internship' ? 'Internship' : t === 'entry' ? 'Entry level' : humanize(t)}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Posted within">
              <NativeSelect value={params.get('age') ?? ''} onChange={(e) => set('age', e.target.value || null)}>
                <option value="">Any time</option>
                <option value="1">Last 24 hours</option>
                <option value="3">Last 3 days</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
              </NativeSelect>
            </Field>
            <Field label="Company">
              <Input value={filters.company ?? ''} onChange={(e) => set('company', e.target.value || null)} placeholder="Any company" />
            </Field>
            <Field label="Location">
              <Input value={filters.location ?? ''} onChange={(e) => set('location', e.target.value || null)} placeholder="e.g. Makati, Philippines" />
            </Field>
            <Field label="Source">
              <NativeSelect value={filters.source ?? ''} onChange={(e) => set('source', e.target.value || null)}>
                <option value="">All sources</option>
                {SOURCE_CATALOG.map((s) => (
                  <option key={s.kind} value={s.kind}>{s.label}</option>
                ))}
                <option value="demo">Demo</option>
              </NativeSelect>
            </Field>
            <Field label="Minimum match">
              <NativeSelect value={params.get('min') ?? ''} onChange={(e) => set('min', e.target.value || null)}>
                <option value="">{view === 'recommended' ? '60% (default)' : 'Any'}</option>
                {[50, 60, 70, 80, 90].map((n) => (
                  <option key={n} value={n}>{n}%</option>
                ))}
              </NativeSelect>
            </Field>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-4">
              {[
                ['salary', 'Salary disclosed'],
                ['expired', 'Include expired'],
                ...(view === 'all' ? [['hidden', 'Show hidden jobs']] : []),
              ].map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-[13px]">
                  <Checkbox checked={params.get(k!) === '1'} onCheckedChange={(v) => set(k!, v ? '1' : null)} />
                  <Label>{label}</Label>
                </label>
              ))}
              {activeFilterCount > 0 && (
                <Button variant="link" size="sm" onClick={() => setParams(params.get('q') ? { q: params.get('q')! } : {}, { replace: true })}>
                  Clear filters
                </Button>
              )}
            </div>
          </Panel>
        )}
        <ErrorNote error={jobs.error} retry={jobs.refetch} />
        <Panel bodyClassName="p-0" title={jobs.data ? `${jobs.data.length}${jobs.data.length >= 150 ? '+' : ''} job${jobs.data.length === 1 ? '' : 's'}` : 'Loading jobs'}>
          {jobs.isLoading ? (
            <div className="grid gap-3 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
          ) : !jobs.data?.length ? (
            <div className="p-4">
              <EmptyState
                icon={meta.icon}
                title={view === 'saved' ? 'No saved jobs' : view === 'recommended' ? 'No recommendations match these filters' : 'No jobs match'}
                action={view === 'all' && !filters.q ? <Button variant="primary" onClick={() => discover.mutate(undefined)}><Radar /> Run discovery</Button> : undefined}
              >
                {view === 'saved'
                  ? 'Use the bookmark on any job to keep it here.'
                  : view === 'recommended'
                    ? 'Recommendations need a verified resume and scored jobs. Lower the minimum match or run matching from the Automation center.'
                    : 'Try a broader search, clear filters, or run discovery to fetch fresh listings.'}
              </EmptyState>
            </div>
          ) : (
            <ul>
              {jobs.data.map((j) => (
                <JobRow key={j.id} job={j} onToggleSave={actions.toggleSave} onHide={actions.toggleHide} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
