import { useQuery } from '@tanstack/react-query';
import { CHART_1, CHART_2, ChartPanel, dailyBuckets } from '@/components/charts';
import { sourceName } from '@/components/domain';
import { ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { useAiUsage, useApplications } from '@/hooks/data';
import { useNow } from '@/hooks/now';
import { check, supabase } from '@/lib/supabase';
import { humanize } from '@/lib/utils';

const SUBMITTED = ['applied', 'assessment', 'interview', 'offer', 'rejected'];

function weekKey(iso: string) {
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export default function Analytics() {
  const apps = useApplications();
  const ai = useAiUsage();
  const now = useNow();
  const since = new Date(now - 90 * 86_400_000).toISOString().slice(0, 10);
  const data = useQuery({
    queryKey: ['analytics', since],
    queryFn: async () => {
      const [jobs, matches, msgs] = await Promise.all([
        supabase.from('job_listings').select('source_key, discovered_at').gte('discovered_at', since).limit(10000),
        supabase.from('job_matches').select('score, eligible').not('score', 'is', null).limit(10000),
        supabase.from('recruitment_messages').select('category, received_at, application_id').gte('received_at', since).limit(5000),
      ]);
      return {
        jobs: check(jobs, 'jobs') as Array<{ source_key: string; discovered_at: string }>,
        matches: check(matches, 'matches') as Array<{ score: number; eligible: boolean }>,
        messages: check(msgs, 'messages') as Array<{ category: string | null; received_at: string; application_id: string | null }>,
      };
    },
  });

  if (data.isLoading || apps.isLoading) return <><PageHeader title="Analytics" /><div className="grid gap-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div></>;
  if (data.error) return <ErrorNote error={data.error} retry={data.refetch} />;
  const d = data.data!;
  const allApps = apps.data ?? [];
  const submitted = allApps.filter((a) => SUBMITTED.includes(a.status) || a.submitted_at);
  const responses = d.messages.filter((m) => ['acknowledgment', 'assessment', 'interview', 'offer', 'rejection'].includes(m.category ?? ''));
  const respondedApps = new Set(responses.map((m) => m.application_id).filter(Boolean));

  const funnel = [
    { label: 'Discovered (90 days)', value: d.jobs.length },
    { label: 'Scored', value: d.matches.length },
    { label: 'Eligible', value: d.matches.filter((m) => m.eligible).length },
    { label: 'Prepared', value: allApps.filter((a) => a.status !== 'discovered' && a.status !== 'saved').length },
    { label: 'Submitted', value: submitted.length },
    { label: 'Got a reply', value: respondedApps.size },
    { label: 'Interview', value: allApps.filter((a) => ['interview', 'offer'].includes(a.status)).length },
    { label: 'Offer', value: allApps.filter((a) => a.status === 'offer').length },
  ];

  const weeks: Record<string, { week: string; submitted: number; responses: number }> = {};
  for (let i = 11; i >= 0; i--) {
    const k = weekKey(new Date(now - i * 7 * 86_400_000).toISOString());
    weeks[k] = { week: new Date(k).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }), submitted: 0, responses: 0 };
  }
  for (const a of submitted) if (a.submitted_at && weeks[weekKey(a.submitted_at)]) weeks[weekKey(a.submitted_at)]!.submitted++;
  for (const m of responses) if (weeks[weekKey(m.received_at)]) weeks[weekKey(m.received_at)]!.responses++;

  const buckets = Array.from({ length: 10 }, (_, i) => ({ range: `${i * 10}–${i === 9 ? 100 : i * 10 + 9}`, jobs: 0 }));
  for (const m of d.matches) buckets[Math.min(9, Math.floor(m.score / 10))]!.jobs++;

  const bySource = new Map<string, number>();
  for (const j of d.jobs) bySource.set(sourceName(j.source_key), (bySource.get(sourceName(j.source_key)) ?? 0) + 1);
  const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([source, jobs]) => ({ source, jobs }));

  const logs = ai.data ?? [];
  const tasks = new Map<string, { calls: number; tokens: number; failures: number }>();
  for (const l of logs) {
    const t = tasks.get(l.task) ?? { calls: 0, tokens: 0, failures: 0 };
    t.calls++;
    t.tokens += l.total_tokens ?? 0;
    if (l.status !== 'success') t.failures++;
    tasks.set(l.task, t);
  }
  const responseRate = submitted.length ? Math.round((respondedApps.size / submitted.length) * 100) : 0;

  return (
    <>
      <PageHeader title="Analytics" description={`Application performance over the last 90 days. Response rate: ${responseRate}% of submitted applications received an employer reply.`} />
      <div className="grid grid-cols-1 gap-4">
        <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface">
          <ol className="grid min-w-[880px] grid-cols-8 divide-x divide-line" aria-label="Application funnel">
            {funnel.map((f, i) => {
              const prev = i ? funnel[i - 1]!.value : 0;
              return (
                <li key={f.label} className="px-3.5 py-3">
                  <p className="text-xs text-muted">{f.label}</p>
                  <p className="type-display figures mt-0.5 text-[26px]">{f.value}</p>
                  {i > 0 && <p className="figures text-[11px] text-muted">{prev ? `${Math.round((f.value / prev) * 100)}% of previous` : '—'}</p>}
                </li>
              );
            })}
          </ol>
        </div>
        <ChartPanel title="Applications and replies per week" description="Last 12 weeks" kind="line" data={Object.values(weeks)} xKey="week" xLabel="Week of" series={[{ key: 'submitted', label: 'Applications submitted', color: CHART_1 }, { key: 'responses', label: 'Employer replies', color: CHART_2 }]} height={240} emptyText="No submitted applications in the last 12 weeks." />
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartPanel title="Match score distribution" description="All scored jobs" kind="bar" data={buckets} xKey="range" xLabel="Score" series={[{ key: 'jobs', label: 'Jobs', color: CHART_1 }]} emptyText="No scored jobs yet." />
          <ChartPanel title="Jobs by source" description="Discovered in the last 90 days" kind="bar" layout="horizontal" data={sources} xKey="source" xLabel="Source" series={[{ key: 'jobs', label: 'Jobs', color: CHART_1 }]} height={Math.max(160, sources.length * 26)} emptyText="No jobs discovered yet." />
        </div>
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <ChartPanel title="Gemini requests per day" description="Last 30 days, all tasks" kind="bar" data={dailyBuckets(logs.filter((l) => l.status !== 'budget_exceeded'), (l) => l.created_at, 30, 'requests')} xKey="day" xLabel="Day" series={[{ key: 'requests', label: 'Requests', color: CHART_1 }]} emptyText="No AI requests yet." />
          <Panel title="AI usage by task" description="Last 30 days" bodyClassName="p-0 overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead><tr className="border-b border-line text-xs text-muted"><th className="px-4 py-2 font-medium">Task</th><th className="px-4 py-2 text-right font-medium">Requests</th><th className="px-4 py-2 text-right font-medium">Tokens</th><th className="px-4 py-2 text-right font-medium">Failed</th></tr></thead>
              <tbody>
                {[...tasks.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([task, t]) => (
                  <tr key={task} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">{humanize(task)}</td>
                    <td className="figures px-4 py-2 text-right">{t.calls}</td>
                    <td className="figures px-4 py-2 text-right">{t.tokens.toLocaleString()}</td>
                    <td className="figures px-4 py-2 text-right">{t.failures}</td>
                  </tr>
                ))}
                {tasks.size === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">No AI requests yet.</td></tr>}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </>
  );
}
