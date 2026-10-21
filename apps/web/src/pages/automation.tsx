import { WORKFLOW_LABELS, WORKFLOWS, type WorkflowKey } from '@applypilot/core';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, ChevronDown, Hand, Play, RotateCcw, ServerCog } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { RunStatusDot } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Badge, ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { Field, Input, NativeSelect, SwitchRow } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/ui/overlay';
import { keys, useAction, useApplications, useRules, useRuns, useSources } from '@/hooks/data';
import { useNow } from '@/hooks/now';
import { post } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { AutomationRules, AutomationRun } from '@/lib/types';
import { cn, formatDateTime, humanize, joinList, splitList, timeAgo } from '@/lib/utils';

const DESCRIPTIONS: Record<WorkflowKey, string> = {
  job_discovery: 'Fetch authorized sources, normalize, deduplicate and store new jobs.',
  resume_analysis: 'Extract and analyze newly uploaded resumes.',
  job_matching: 'Score new jobs: rules first, then Gemini for eligible ones.',
  application_prep: 'Generate tailored documents for jobs that meet your preparation rule.',
  application_submit: 'Dispatch approved submissions to the Playwright runner.',
  gmail_sync: 'Import recruitment emails and job alerts, then classify them.',
  follow_up: 'Draft follow-ups for applications without a reply.',
  reports: 'Daily summary, weekly statistics and interview reminders.',
  error_recovery: 'Retry failed runs with backoff and report persistent failures.',
};

function EngineStatus({ rules }: { rules?: AutomationRules }) {
  const runs = useRuns({ status: 'queued', limit: 50 });
  const now = useNow();
  const seen = rules?.n8n_last_seen_at;
  const age = seen ? now - Date.parse(seen) : null;
  const state = age === null ? 'never' : age < 5 * 60_000 ? 'online' : 'offline';
  return (
    <Panel title="Automation engine (n8n)" description="n8n polls the queue every minute and runs every scheduled workflow.">
      <div className="grid gap-3 text-[13px] sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted">Status</p>
          <p className={cn('mt-0.5 flex items-center gap-1.5 font-semibold', state === 'online' ? 'text-jade' : state === 'offline' ? 'text-amber' : 'text-muted')}>
            <span className="size-2 rounded-full bg-current" aria-hidden /> {state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'Never connected'}
          </p>
          <p className="text-xs text-muted">{seen ? `Last check-in ${timeAgo(seen)}` : 'Start n8n with Docker Compose'}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Queued runs</p>
          <p className="type-display figures text-[24px]">{runs.data?.length ?? '—'}</p>
        </div>
        <div className="text-xs text-ink-2">
          {state !== 'online' ? 'Local n8n stops when your computer is off or asleep. Queued runs wait safely and resume when n8n is back. For 24/7 automation, host n8n on an always-on VM (see docs/DEPLOYMENT.md).' : 'Scheduled workflows are running.'}
        </div>
      </div>
    </Panel>
  );
}

function RunRow({ run }: { run: AutomationRun }) {
  const [open, setOpen] = React.useState(false);
  const cancel = useAction(() => post(`/automation/runs/${run.id}/cancel`), { success: 'Cancellation requested', invalidate: [['runs']] });
  const retry = useAction(() => post(`/automation/runs/${run.id}/retry`), { success: 'Retry queued', invalidate: [['runs']] });
  const stats = Object.entries(run.stats ?? {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
  const duration = run.started_at && run.finished_at ? Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000) : null;
  return (
    <li className="border-b border-line last:border-0">
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-2.5 text-[13px]">
        <RunStatusDot status={run.status} />
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="font-medium">{WORKFLOW_LABELS[run.workflow]}</span>
          <span className="text-xs text-muted">{humanize(run.status)} · {run.trigger}{run.attempt > 1 ? ` · attempt ${run.attempt}/${run.max_attempts}` : ''}</span>
          {run.error && <span className="hidden min-w-0 truncate text-xs text-rose md:inline">{run.error}</span>}
          <ChevronDown className={cn('ml-auto size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
        </button>
        <span className="w-24 shrink-0 text-right text-[11px] text-muted">{timeAgo(run.created_at)}</span>
        {['queued', 'running'].includes(run.status) && !run.cancel_requested && <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(undefined)}><Ban /> Cancel</Button>}
        {['failed', 'cancelled', 'partial'].includes(run.status) && run.workflow !== 'application_submit' && <Button size="sm" variant="ghost" loading={retry.isPending} onClick={() => retry.mutate(undefined)}><RotateCcw /> Retry</Button>}
      </div>
      {open && (
        <div className="grid gap-2 bg-surface-2/50 px-4 py-3 text-xs">
          <p className="text-muted">Queued {formatDateTime(run.queued_at)}{run.started_at ? ` · started ${formatDateTime(run.started_at)}` : ''}{duration !== null ? ` · took ${duration}s` : ''}{run.n8n_execution_id ? ` · n8n execution ${run.n8n_execution_id}` : ''}</p>
          {stats.length > 0 && <dl className="flex flex-wrap gap-x-4 gap-y-1">{stats.map(([k, v]) => <div key={k}><dt className="inline text-muted">{humanize(k)}: </dt><dd className="figures inline font-semibold">{String(v)}</dd></div>)}</dl>}
          {run.error && <p className="text-rose">{run.error}</p>}
          {run.item_errors?.length > 0 && (
            <div>
              <p className="font-semibold">{run.item_errors.length} item(s) failed — the rest of the batch continued</p>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-4 text-ink-2">{run.item_errors.slice(0, 50).map((e, i) => <li key={i}>{JSON.stringify(e).slice(0, 220)}</li>)}</ul>
            </div>
          )}
          {Object.keys(run.input ?? {}).length > 0 && <p className="text-muted">Input: <code>{JSON.stringify(run.input).slice(0, 300)}</code></p>}
        </div>
      )}
    </li>
  );
}

function RulesEditor({ rules }: { rules: AutomationRules }) {
  const qc = useQueryClient();
  const sources = useSources();
  const [confirmAuto, setConfirmAuto] = React.useState(false);
  const save = async (patch: Partial<AutomationRules>) => {
    const { error } = await supabase.from('automation_rules').update(patch).eq('id', rules.id);
    if (error) return toast.error(error.message);
    toast.success('Automation rules saved');
    qc.invalidateQueries({ queryKey: keys.rules });
  };
  const num = (k: keyof AutomationRules, min: number, max: number) => (e: React.FocusEvent<HTMLInputElement>) => {
    const v = e.target.value === '' ? null : Number(e.target.value);
    if (v !== null && (Number.isNaN(v) || v < min || v > max)) return toast.error(`Enter a value between ${min} and ${max}`);
    if (v !== rules[k]) save({ [k]: v } as Partial<AutomationRules>);
  };
  const allowed = (sources.data ?? []).filter((s) => s.automation_allowed);
  const modes = [
    { id: 'manual', title: 'Manual', body: 'AI discovers jobs and prepares documents. You submit every application yourself.' },
    { id: 'approval', title: 'Approval', body: 'The runner fills permitted forms for review. Nothing is submitted until you approve it.' },
    { id: 'auto', title: 'Conditional auto-apply', body: 'Submits automatically through authorized sources when every rule below passes. Requires opt-in.' },
  ] as const;
  return (
    <Panel title="Application mode & rules" description="Every rule is enforced by the Worker and the database before anything is submitted.">
      <div className="grid gap-5">
        <fieldset className="grid gap-2 sm:grid-cols-3">
          <legend className="sr-only">Application mode</legend>
          {modes.map((m) => (
            <label key={m.id} className={cn('cursor-pointer rounded-[var(--radius-control)] border p-3 text-[13px]', rules.mode === m.id ? 'border-jade bg-jade-soft/40' : 'border-line hover:border-line-strong')}>
              <input type="radio" name="mode" className="sr-only" checked={rules.mode === m.id} onChange={() => (m.id === 'auto' && !rules.auto_apply_opt_in_at ? setConfirmAuto(true) : save({ mode: m.id }))} />
              <span className="flex items-center gap-2 font-semibold"><span className={cn('size-3 rounded-full border-2', rules.mode === m.id ? 'border-jade bg-jade' : 'border-line-strong')} aria-hidden />{m.title}</span>
              <span className="mt-1 block text-xs text-ink-2">{m.body}</span>
            </label>
          ))}
        </fieldset>
        <ConfirmDialog
          open={confirmAuto}
          onOpenChange={setConfirmAuto}
          title="Turn on conditional auto-apply?"
          description={
            <div className="grid gap-2">
              <p>ApplyPilot will submit applications without asking, but only when all of these hold:</p>
              <ul className="list-disc pl-5">
                <li>the source explicitly permits automation ({allowed.map((s) => s.name).join(', ') || 'none yet'}),</li>
                <li>the job passes every mandatory eligibility rule and scores at least {rules.min_match_score}%,</li>
                <li>the salary is disclosed and meets your minimum, and the company isn't excluded,</li>
                <li>fewer than {rules.max_daily_submissions} automatic submissions were made today,</li>
                <li>no CAPTCHA appears — the runner never bypasses one.</li>
              </ul>
              <p>You can pause everything at any time from the status bar.</p>
            </div>
          }
          confirmLabel="Turn on auto-apply"
          onConfirm={() => save({ mode: 'auto', auto_apply_enabled: true })}
        />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <p className="text-[13px] font-semibold">Auto-apply restrictions</p>
            <SwitchRow label="Auto-apply enabled" description={rules.auto_apply_opt_in_at ? `Opted in ${formatDateTime(rules.auto_apply_opt_in_at)}` : 'Requires explicit opt-in'} checked={rules.auto_apply_enabled} onCheckedChange={(v) => (v ? setConfirmAuto(true) : save({ auto_apply_enabled: false, mode: rules.mode === 'auto' ? 'approval' : rules.mode }))} />
            <Field label="Allowed sources for auto-apply" hint={`Comma-separated source keys. Sources permitting automation: ${allowed.map((s) => s.key).join(', ') || 'none'}`}>
              <Input defaultValue={joinList(rules.allowed_sources)} onBlur={(e) => save({ allowed_sources: splitList(e.target.value) })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Minimum match %"><Input type="number" min={0} max={100} defaultValue={rules.min_match_score} onBlur={num('min_match_score', 0, 100)} /></Field>
              <Field label="Max submissions per day"><Input type="number" min={0} max={25} defaultValue={rules.max_daily_submissions} onBlur={num('max_daily_submissions', 0, 25)} /></Field>
              <Field label="Minimum salary (USD/hour)" hint="Unknown salaries never qualify"><Input type="number" min={0} step="0.5" defaultValue={rules.min_salary_hourly_usd ?? ''} onBlur={num('min_salary_hourly_usd', 0, 500)} /></Field>
              <Field label="Resume to submit">
                <NativeSelect value={rules.resume_selection} onChange={(e) => save({ resume_selection: e.target.value as 'primary' | 'tailored' })}>
                  <option value="tailored">Tailored per job</option>
                  <option value="primary">Verified master resume</option>
                </NativeSelect>
              </Field>
            </div>
            <Field label="Preferred job categories" hint="Title keywords, comma-separated (empty = any)"><Input defaultValue={joinList(rules.preferred_categories)} onBlur={(e) => save({ preferred_categories: splitList(e.target.value) })} /></Field>
            <Field label="Excluded companies"><Input defaultValue={joinList(rules.excluded_companies)} onBlur={(e) => save({ excluded_companies: splitList(e.target.value) })} /></Field>
          </div>
          <div className="grid content-start gap-3">
            <p className="text-[13px] font-semibold">Approval & preparation</p>
            <SwitchRow label="Require document approval" description="Tailored resume and cover letter must be approved before any submission" checked={rules.require_document_approval} onCheckedChange={(v) => save({ require_document_approval: v })} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Auto-prepare documents at %" hint="Approval and auto modes"><Input type="number" min={0} max={100} defaultValue={rules.auto_prepare_min_score} onBlur={num('auto_prepare_min_score', 0, 100)} /></Field>
              <Field label="Notify me at match %"><Input type="number" min={0} max={100} defaultValue={rules.notify_min_score} onBlur={num('notify_min_score', 0, 100)} /></Field>
              <Field label="Follow up after (days)"><Input type="number" min={1} max={60} defaultValue={rules.follow_up_after_days} onBlur={num('follow_up_after_days', 1, 60)} /></Field>
              <Field label="Daily Gemini budget" hint="Requests per 24 h"><Input type="number" min={0} max={5000} defaultValue={rules.ai_daily_request_budget} onBlur={num('ai_daily_request_budget', 0, 5000)} /></Field>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

export default function Automation() {
  const rules = useRules();
  const [workflow, setWorkflow] = React.useState('');
  const [status, setStatus] = React.useState('');
  const runs = useRuns({ workflow: workflow || undefined, status: status || undefined, limit: 100 });
  const apps = useApplications();
  const manual = (apps.data ?? []).filter((a) => a.needs_manual_action);
  const trigger = useAction((w: WorkflowKey) => post('/automation/trigger', { workflow: w }), { success: 'Run queued', invalidate: [['runs']] });
  const lastRun = (w: WorkflowKey) => runs.data?.find((r) => r.workflow === w);

  return (
    <>
      <PageHeader title="Automation center" description="Monitor every n8n workflow run, trigger runs manually, and control how far automation may go." />
      <div className="grid gap-4">
        <EngineStatus rules={rules.data} />
        {manual.length > 0 && (
          <Panel title={`Manual-action queue (${manual.length})`} description="Submissions automation could not or may not complete. Apply on the original site, then mark them applied." bodyClassName="p-0">
            <ul>{manual.map((a) => <li key={a.id} className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] last:border-0"><Hand className="size-4 text-amber" /><Link to={`/applications/${a.id}`} className="font-medium hover:text-jade">{a.job_title} — {a.company}</Link><span className="ml-auto truncate text-xs text-muted">{a.manual_action_reason}</span></li>)}</ul>
          </Panel>
        )}
        <Panel title="Workflows" bodyClassName="p-0">
          <ul className="grid md:grid-cols-2">
            {WORKFLOWS.map((w) => {
              const last = lastRun(w);
              return (
                <li key={w} className="flex items-start gap-3 border-b border-line px-4 py-3 md:odd:border-r">
                  <ServerCog className="mt-0.5 size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold">{WORKFLOW_LABELS[w]}</p>
                    <p className="text-xs text-muted">{DESCRIPTIONS[w]}</p>
                    {last && <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-2"><RunStatusDot status={last.status} /> {humanize(last.status)} {timeAgo(last.created_at)}</p>}
                  </div>
                  {w !== 'application_submit' && <Button size="sm" variant="ghost" disabled={rules.data?.paused} onClick={() => trigger.mutate(w)}><Play /> Run</Button>}
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel
          title="Execution log"
          bodyClassName="p-0"
          actions={
            <>
              <NativeSelect aria-label="Filter workflow" className="h-7 w-44 text-xs" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                <option value="">All workflows</option>
                {WORKFLOWS.map((w) => <option key={w} value={w}>{WORKFLOW_LABELS[w]}</option>)}
              </NativeSelect>
              <NativeSelect aria-label="Filter status" className="h-7 w-32 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any status</option>
                {['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </NativeSelect>
            </>
          }
        >
          <ErrorNote error={runs.error} retry={runs.refetch} />
          {runs.isLoading ? <div className="grid gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div> : runs.data?.length ? <ul>{runs.data.map((r) => <RunRow key={r.id} run={r} />)}</ul> : <p className="px-4 py-6 text-center text-[13px] text-muted">No runs match.</p>}
        </Panel>
        {rules.data ? <RulesEditor rules={rules.data} /> : <Skeleton className="h-64" />}
        {rules.data?.paused && <Badge tone="rose" className="justify-self-start">Automation is paused{rules.data.paused_reason ? `: ${rules.data.paused_reason}` : ''}</Badge>}
      </div>
    </>
  );
}
