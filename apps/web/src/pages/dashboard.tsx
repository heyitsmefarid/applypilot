import { APPLICATION_STATUS_LABELS, APPLICATION_STATUSES, EMAIL_CATEGORY_LABELS, WORKFLOW_LABELS } from '@applypilot/core';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Mail, Radar, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { CHART_1, ChartPanel, dailyBuckets } from '@/components/charts';
import { RunStatusDot, ScoreRing } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { useAction, useApplications, useMessages, useProfile, useRuns, useStats } from '@/hooks/data';
import { post } from '@/lib/api';
import { check, supabase } from '@/lib/supabase';
import type { JobWithMatch } from '@/lib/types';
import { cn, timeAgo } from '@/lib/utils';

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** One instrument bar instead of a grid of identical cards. */
function StatStrip() {
  const { data: s, isLoading, error, refetch } = useStats();
  if (error) return <ErrorNote error={error} retry={refetch} />;
  const cells: Array<{ label: string; value?: number; sub?: string; to: string; tone?: 'jade' | 'amber' | 'rose' }> = [
    { label: 'Jobs discovered', value: s?.jobs_total, sub: s ? `${s.jobs_new_24h} new today` : undefined, to: '/discover' },
    { label: 'High matches', value: s?.high_matches, sub: '75% and above', to: '/recommended', tone: 'jade' },
    { label: 'Saved', value: s?.saved, to: '/saved' },
    { label: 'Submitted', value: s?.submitted, to: '/applications' },
    { label: 'Pending reply', value: s?.pending, to: '/applications' },
    { label: 'Needs you', value: s?.awaiting_action, sub: 'drafts and approvals', to: '/applications', tone: s?.awaiting_action ? 'amber' : undefined },
    { label: 'Interviews', value: s?.interviews_upcoming, sub: 'upcoming', to: '/interviews', tone: 'jade' },
    { label: 'Rejected', value: s?.rejected, to: '/applications' },
    { label: 'Offers', value: s?.offers, to: '/applications', tone: s?.offers ? 'jade' : undefined },
  ];
  return (
    <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface">
      <dl className="grid min-w-[880px] grid-cols-9 divide-x divide-line">
        {cells.map((c) => (
          <Link key={c.label} to={c.to} className="group px-3.5 py-3 hover:bg-surface-2/60">
            <dt className="text-xs text-muted group-hover:text-ink-2">{c.label}</dt>
            <dd className={cn('type-display figures mt-0.5 text-[28px]', c.tone === 'jade' && 'text-jade', c.tone === 'amber' && 'text-amber', c.tone === 'rose' && 'text-rose')}>
              {isLoading ? <Skeleton className="mt-1 h-7 w-10" /> : (c.value ?? 0)}
            </dd>
            {c.sub && <p className="text-[11px] text-muted">{c.sub}</p>}
          </Link>
        ))}
      </dl>
    </div>
  );
}

function Recommendations() {
  const { data, isLoading } = useQuery({
    queryKey: ['jobs', 'dashboard-top'],
    queryFn: async () =>
      check(
        await supabase
          .from('job_listings')
          .select('id, title, company, location, work_arrangement, job_matches!inner(score, eligible, status, recommendation, explanation, scored_at)')
          .eq('status', 'active')
          .eq('is_hidden', false)
          .eq('job_matches.eligible', true)
          .gte('job_matches.score', 60)
          .order('discovered_at', { ascending: false })
          .limit(30),
        'recommendations',
      ) as unknown as Array<Pick<JobWithMatch, 'id' | 'title' | 'company' | 'location' | 'work_arrangement' | 'job_matches'>>,
  });
  const top = [...(data ?? [])].sort((a, b) => (b.job_matches[0]?.score ?? 0) - (a.job_matches[0]?.score ?? 0)).slice(0, 5);
  return (
    <Panel title="Recent AI recommendations" description="Eligible jobs ranked by match score" actions={<Button variant="ghost" size="sm" asChild><Link to="/recommended">See all</Link></Button>} bodyClassName="p-0">
      {isLoading ? (
        <div className="grid gap-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : top.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={Sparkles} title="No recommendations yet">
            Verify your resume and run discovery. Jobs that pass your eligibility rules are scored here.
          </EmptyState>
        </div>
      ) : (
        <ul>
          {top.map((j) => (
            <li key={j.id} className="relative flex items-start gap-3 border-b border-line px-4 py-3 last:border-0 hover:bg-surface-2/50">
              <ScoreRing match={j.job_matches[0]} size={40} />
              <div className="min-w-0">
                <Link to={`/jobs/${j.id}`} className="font-semibold after:absolute after:inset-0 hover:text-jade">
                  {j.title}
                </Link>
                <p className="text-xs text-muted">
                  {j.company} · {j.location || j.work_arrangement}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-ink-2">{j.job_matches[0]?.explanation}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Pipeline() {
  const { data = [] } = useApplications();
  const rows = APPLICATION_STATUSES.map((s) => ({ status: APPLICATION_STATUS_LABELS[s], count: data.filter((a) => a.status === s).length })).filter((r) => r.count > 0);
  return <ChartPanel title="Application pipeline" description="Applications in each status" kind="bar" layout="horizontal" data={rows} xKey="status" xLabel="Status" series={[{ key: 'count', label: 'Applications', color: CHART_1 }]} height={Math.max(140, rows.length * 26)} emptyText="Track a job to start your pipeline." />;
}

function Discovered() {
  const { data = [] } = useQuery({
    queryKey: ['jobs', 'discovered-14d'],
    queryFn: async () => check(await supabase.from('job_listings').select('discovered_at').gte('discovered_at', new Date(Date.now() - 14 * 86_400_000).toISOString()).limit(5000), 'discovered') as Array<{ discovered_at: string }>,
  });
  return <ChartPanel title="Jobs discovered" description="New listings per day, last 14 days" kind="bar" data={dailyBuckets(data, (r) => r.discovered_at, 14, 'jobs')} xKey="day" xLabel="Day" series={[{ key: 'jobs', label: 'Jobs', color: CHART_1 }]} height={180} emptyText="No jobs discovered in the last 14 days." />;
}

function LatestEmails() {
  const { data = [], isLoading } = useMessages({});
  const items = data.filter((m) => m.category !== 'job_alert').slice(0, 5);
  return (
    <Panel title="Latest recruitment emails" actions={<Button variant="ghost" size="sm" asChild><Link to="/inbox">Open inbox</Link></Button>} bodyClassName="p-0">
      {isLoading ? (
        <div className="grid gap-3 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : items.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={Mail} title="No recruitment emails">
            Connect Gmail in Integrations to track employer replies automatically.
          </EmptyState>
        </div>
      ) : (
        <ul>
          {items.map((m) => (
            <li key={m.id} className="border-b border-line px-4 py-2.5 last:border-0">
              <Link to={`/inbox?message=${m.id}`} className="block hover:text-jade">
                <div className="flex items-center justify-between gap-2">
                  <span className={cn('truncate text-[13px]', !m.is_read && 'font-semibold')}>{m.from_name || m.from_email}</span>
                  <span className="shrink-0 text-[11px] text-muted">{timeAgo(m.received_at)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs text-ink-2">{m.subject}</span>
                  {m.category && <Badge tone={m.category === 'offer' || m.category === 'interview' ? 'jade' : m.category === 'rejection' ? 'rose' : 'neutral'}>{EMAIL_CATEGORY_LABELS[m.category]}</Badge>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Activity() {
  const { data = [], isLoading } = useRuns({ limit: 8 });
  const failures = data.filter((r) => r.status === 'failed');
  return (
    <Panel title="Automation activity" description={failures.length ? `${failures.length} recent failure(s)` : 'Latest workflow runs'} actions={<Button variant="ghost" size="sm" asChild><Link to="/automation">Automation center</Link></Button>} bodyClassName="p-0">
      {isLoading ? (
        <div className="grid gap-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : data.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={Radar} title="No runs yet">
            Start n8n with Docker Compose, or queue a discovery run from here. Runs wait in the queue until n8n picks them up.
          </EmptyState>
        </div>
      ) : (
        <ul>
          {data.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 border-b border-line px-4 py-2 text-[13px] last:border-0">
              <RunStatusDot status={r.status} />
              <span className="min-w-0 flex-1 truncate">{WORKFLOW_LABELS[r.workflow]}</span>
              {r.status === 'failed' && (
                <span className="flex min-w-0 items-center gap-1 truncate text-xs text-rose" title={r.error ?? ''}>
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span className="truncate">{r.error}</span>
                </span>
              )}
              <span className="shrink-0 text-[11px] text-muted">{timeAgo(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function Dashboard() {
  const profile = useProfile();
  const firstName = profile.data?.full_name?.split(' ')[0];
  const discover = useAction(() => post('/automation/trigger', { workflow: 'job_discovery' }), { success: 'Discovery queued. n8n picks it up within a minute.', invalidate: [['runs']] });
  return (
    <>
      <PageHeader
        title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
        description={profile.data && !profile.data.verified_resume_version_id ? 'Verify your resume to unlock AI matching and tailoring.' : 'Your job search at a glance.'}
        actions={
          <>
            {profile.data && !profile.data.verified_resume_version_id && (
              <Button variant="caution" asChild>
                <Link to="/resume">Verify resume</Link>
              </Button>
            )}
            <Button variant="primary" loading={discover.isPending} onClick={() => discover.mutate(undefined)}>
              <Radar /> Run discovery now
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4">
        <StatStrip />
        <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
          <Recommendations />
          <Pipeline />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Discovered />
          <LatestEmails />
          <Activity />
        </div>
      </div>
    </>
  );
}

