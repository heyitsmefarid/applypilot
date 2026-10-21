import { SOURCE_CATALOG } from '@applypilot/core/sources';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, CircleDashed, GitBranch, Mail, PlugZap, Sparkles, XCircle } from 'lucide-react';
import * as React from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { Field, Input, Switch } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/ui/overlay';
import { keys, useAction, useIntegrations, useSources } from '@/hooks/data';
import { useNow } from '@/hooks/now';
import { api, post } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { JobSource } from '@/lib/types';
import { cn, errorMessage, humanize, joinList, splitList, timeAgo } from '@/lib/utils';

function StatusLine({ ok, label, detail }: { ok: boolean | null; label: string; detail?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[13px]">
      {ok === null ? <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted" /> : ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-jade" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-rose" />}
      <span><span className="font-medium">{label}</span>{detail && <span className="block text-xs text-muted">{detail}</span>}</span>
    </div>
  );
}

const CONFIG_FIELDS: Record<string, { key: string; label: string; hint: string }> = {
  greenhouse: { key: 'boards', label: 'Board tokens', hint: 'From boards.greenhouse.io/<token>, comma-separated' },
  lever: { key: 'companies', label: 'Company slugs', hint: 'From jobs.lever.co/<slug>, comma-separated' },
  ashby: { key: 'organizations', label: 'Organizations', hint: 'From jobs.ashbyhq.com/<org>, comma-separated' },
  remotive: { key: 'search_terms', label: 'Search terms', hint: 'Optional; defaults to your search profile roles' },
  jobicy: { key: 'tags', label: 'Tags', hint: 'Optional, e.g. react, python' },
};

function SourceRow({ s }: { s: JobSource }) {
  const qc = useQueryClient();
  const meta = SOURCE_CATALOG.find((c) => c.kind === s.kind);
  const field = CONFIG_FIELDS[s.kind];
  const [confirmAuto, setConfirmAuto] = React.useState(false);
  const update = async (patch: Partial<JobSource>) => {
    const { error } = await supabase.from('job_sources').update(patch).eq('id', s.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: keys.sources });
  };
  const configValue = field ? (Array.isArray(s.config[field.key]) ? joinList(s.config[field.key] as string[]) : String(s.config[field.key] ?? '')) : '';
  return (
    <li className="grid gap-3 border-b border-line px-4 py-3 last:border-0 md:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-semibold">{s.name}</span>
          <Badge tone="outline">{meta?.access ?? humanize(s.kind)}</Badge>
          {s.last_status && <Badge tone={s.last_status === 'ok' ? 'jade' : s.last_status === 'partial' ? 'amber' : 'rose'}>{humanize(s.last_status)}</Badge>}
          {s.automation_allowed && <Badge tone="amber">Automation permitted</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {meta?.note}
          {s.last_run_at && ` Last fetch ${timeAgo(s.last_run_at)}${s.last_job_count !== null ? `, ${s.last_job_count} new` : ''}.`}
        </p>
        {s.last_error && <p className="mt-0.5 text-xs text-rose">{s.last_error}</p>}
        {field && (
          <div className="mt-2 max-w-lg">
            <Field label={field.label} hint={field.hint}>
              <Input defaultValue={configValue} onBlur={(e) => {
                const v = splitList(e.target.value);
                if (v.join(',') !== splitList(configValue).join(',')) update({ config: { ...s.config, [field.key]: v } }).then(() => toast.success(`${s.name} updated`));
              }} />
            </Field>
          </div>
        )}
      </div>
      <div className="flex items-start gap-4 text-xs">
        <label className="flex items-center gap-2">Enabled <Switch checked={s.enabled} onCheckedChange={(v) => update({ enabled: v })} aria-label={`Enable ${s.name}`} /></label>
        <label className="flex items-center gap-2">Allow automated submission <Switch checked={s.automation_allowed} onCheckedChange={(v) => (v ? setConfirmAuto(true) : update({ automation_allowed: false }))} aria-label={`Allow automated submission for ${s.name}`} /></label>
        <ConfirmDialog
          open={confirmAuto}
          onOpenChange={setConfirmAuto}
          title={`Allow automated submissions for ${s.name}?`}
          description="Only enable this if the platform's terms permit automated applications and its forms have no CAPTCHA. The runner also needs the host on RUNNER_ALLOWED_HOSTS. LinkedIn, Indeed, JobStreet and OnlineJobs.ph prohibit it."
          confirmLabel="Allow automation"
          onConfirm={() => update({ automation_allowed: true })}
        />
      </div>
    </li>
  );
}

export default function Integrations() {
  const [params, setParams] = useSearchParams();
  const [checkModels, setCheckModels] = React.useState(false);
  const status = useIntegrations(checkModels);
  const sources = useSources();
  const qc = useQueryClient();
  const disconnect = useAction(() => post('/integrations/gmail/disconnect'), { success: 'Gmail disconnected and access revoked', invalidate: [keys.integrations] });

  React.useEffect(() => {
    const g = params.get('gmail');
    if (!g) return;
    if (g === 'connected') toast.success('Gmail connected');
    else toast.error(`Gmail connection failed: ${params.get('reason') ?? 'unknown error'}`);
    qc.invalidateQueries({ queryKey: keys.integrations });
    setParams({}, { replace: true });
  }, [params, setParams, qc]);

  const connectGmail = async () => {
    try {
      const { url } = await api<{ url: string }>('/integrations/gmail/auth-url');
      window.location.assign(url);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const now = useNow();
  const s = status.data;
  const n8nAge = s?.n8n_last_seen_at ? now - Date.parse(s.n8n_last_seen_at) : null;

  return (
    <>
      <PageHeader title="Integrations" description="Connections and job sources. Secrets live in the Worker and n8n — this page only shows whether they are configured." />
      <ErrorNote error={status.error} retry={status.refetch} />
      <div className="grid gap-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={<span className="flex items-center gap-2"><Mail className="size-4" /> Gmail</span>} description="Job alerts, employer replies, approved sending">
            {status.isLoading ? <Skeleton className="h-20" /> : (
              <div className="grid gap-3">
                <StatusLine ok={s?.gmail_oauth ?? false} label="Google OAuth client" detail={s?.gmail_oauth ? 'Configured on the Worker' : 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI'} />
                <StatusLine ok={s?.gmail ? s.gmail.status === 'connected' : null} label={s?.gmail ? s.gmail.email : 'Not connected'} detail={s?.gmail ? `${humanize(s.gmail.status)}${s.gmail.last_sync_at ? ` · last sync ${timeAgo(s.gmail.last_sync_at)}` : ''}${s.gmail.last_error ? ` · ${s.gmail.last_error}` : ''}` : 'Grants read access plus draft/send. Sending always requires your confirmation.'} />
                <div className="flex flex-wrap gap-2">
                  {(!s?.gmail || s.gmail.status !== 'connected') && <Button variant="primary" disabled={!s?.gmail_oauth} onClick={connectGmail}><PlugZap /> {s?.gmail ? 'Reconnect Gmail' : 'Connect Gmail'}</Button>}
                  {s?.gmail && <ConfirmDialog trigger={<Button variant="ghost">Disconnect</Button>} title="Disconnect Gmail?" description="ApplyPilot revokes its Google access and deletes the stored tokens. Imported emails stay in your inbox here." confirmLabel="Disconnect Gmail" danger onConfirm={() => disconnect.mutateAsync(undefined).then(() => undefined)} />}
                </div>
                <p className="text-xs text-muted">Google OAuth apps in "Testing" status issue refresh tokens that expire after 7 days — reconnect weekly, or publish the app for personal use.</p>
              </div>
            )}
          </Panel>
          <Panel title={<span className="flex items-center gap-2"><Sparkles className="size-4" /> Gemini</span>} description="Free-tier AI for extraction, matching and writing" actions={<Button size="sm" variant="ghost" loading={status.isFetching && checkModels} onClick={() => { setCheckModels(true); status.refetch(); }}>Check models</Button>}>
            {status.isLoading ? <Skeleton className="h-20" /> : (
              <div className="grid gap-3">
                <StatusLine ok={s?.gemini ?? false} label="API key" detail={s?.gemini ? 'Configured on the Worker' : 'Set GEMINI_API_KEY (Google AI Studio, free tier)'} />
                <StatusLine ok={s?.model_checks ? (s.model_checks[s.models.fast]?.ok ?? false) : null} label={`Fast model: ${s?.models.fast}`} detail={s?.model_checks?.[s.models.fast]?.detail ?? 'Extraction, matching, classification'} />
                <StatusLine ok={s?.model_checks ? (s.model_checks[s.models.quality]?.ok ?? false) : null} label={`Writing model: ${s?.models.quality}`} detail={s?.model_checks?.[s.models.quality]?.detail ?? 'Enhancement, tailoring, cover letters'} />
                <p className="text-xs text-muted">API style: {s?.models.api}. Free-tier prompts may be used by Google to improve its products — don't upload anything you wouldn't share.</p>
              </div>
            )}
          </Panel>
          <Panel title={<span className="flex items-center gap-2"><Bot className="size-4" /> n8n automation engine</span>}>
            <div className="grid gap-3">
              <StatusLine ok={n8nAge === null ? null : n8nAge < 5 * 60_000} label={n8nAge === null ? 'Never connected' : n8nAge < 5 * 60_000 ? 'Polling the queue' : 'Not polling'} detail={s?.n8n_last_seen_at ? `Last check-in ${timeAgo(s.n8n_last_seen_at)}` : 'Run docker compose up in /n8n and import the workflows'} />
              <StatusLine ok={s?.n8n_push ?? false} label="Instant push (optional)" detail={s?.n8n_push ? 'Runs are pushed to n8n through your HTTPS tunnel' : 'Not configured — n8n picks up runs within a minute by polling'} />
            </div>
          </Panel>
          <Panel title={<span className="flex items-center gap-2"><GitBranch className="size-4" /> Playwright runner</span>}>
            <div className="grid gap-3">
              <StatusLine ok={s?.github_runner ?? false} label="GitHub Actions dispatch" detail={s?.github_runner ? 'Approved submissions run on GitHub Actions' : 'Not configured — use the local runner (npm run runner:watch)'} />
              <StatusLine ok={s?.token_encryption ?? false} label="Token encryption key" detail="AES-256-GCM key for stored OAuth tokens" />
            </div>
          </Panel>
        </div>
        <Panel title="Job sources" description="Only official APIs, public job-board endpoints, your job-alert emails and URLs you import. No scraping of platforms that restrict it." bodyClassName="p-0">
          {sources.isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : (
            <ul>{(sources.data ?? []).map((src) => <SourceRow key={src.id} s={src} />)}</ul>
          )}
          {!sources.isLoading && !sources.data?.length && <p className={cn('px-4 py-6 text-[13px] text-muted')}>Sources are created on first sign-in. Reload the page if this is your first visit.</p>}
        </Panel>
      </div>
    </>
  );
}
