import { EMAIL_CATEGORIES, EMAIL_CATEGORY_LABELS } from '@applypilot/core';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox as InboxIcon, Link2, RefreshCw, Send, Sparkles } from 'lucide-react';
import * as React from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { NativeSelect, Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useAction, useApplications, useIntegrations, useMessages } from '@/hooks/data';
import { post } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { RecruitmentMessage } from '@/lib/types';
import { cn, formatDateTime, humanize, timeAgo } from '@/lib/utils';

const tone = (c: string | null) => (c === 'offer' || c === 'interview' ? 'jade' : c === 'rejection' ? 'rose' : c === 'assessment' ? 'sky' : c === 'job_alert' ? 'outline' : 'neutral');

function MessageView({ m, onChange }: { m: RecruitmentMessage; onChange: () => void }) {
  const apps = useApplications();
  const [reply, setReply] = React.useState(m.suggested_reply ?? '');
  const classify = useAction(() => post(`/messages/${m.id}/classify`), { success: 'Classified', onSuccess: onChange });
  const send = useAction(() => post(`/messages/${m.id}/send-reply`, { body: reply, confirm: true }), { success: `Reply sent to ${m.from_email}`, onSuccess: onChange });
  const c = m.classification as { summary?: string; instructions?: string[]; deadline_iso?: string | null; company?: string; job_title?: string } | null;
  const update = async (patch: Record<string, unknown>) => {
    const { error } = await supabase.from('recruitment_messages').update(patch).eq('id', m.id);
    if (error) toast.error(error.message);
    onChange();
  };
  React.useEffect(() => {
    if (!m.is_read) supabase.from('recruitment_messages').update({ is_read: true }).eq('id', m.id).then(onChange);
  }, [m.id, m.is_read, onChange]);

  return (
    <Panel
      title={m.subject || '(no subject)'}
      description={`${m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email} · ${formatDateTime(m.received_at)}`}
      actions={<Button size="sm" variant="ghost" loading={classify.isPending} onClick={() => classify.mutate(undefined)}><Sparkles /> {m.category ? 'Re-classify' : 'Classify'}</Button>}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <NativeSelect aria-label="Category" className="h-7 w-48 text-xs" value={m.category ?? ''} onChange={(e) => update({ category: e.target.value || null, classified_by: 'user', processed_status: 'classified' })}>
            <option value="">Unclassified</option>
            {EMAIL_CATEGORIES.map((k) => <option key={k} value={k}>{EMAIL_CATEGORY_LABELS[k]}</option>)}
          </NativeSelect>
          {m.confidence !== null && <span className="text-xs text-muted">{Math.round(Number(m.confidence) * 100)}% confidence · {m.classified_by}</span>}
          <Badge tone={m.sender_verified ? 'jade' : 'amber'} title={m.sender_verified ? 'Gmail authenticated this sender (DKIM/SPF/DMARC)' : 'Gmail could not authenticate this sender — treat its claims with care'}>
            {m.sender_verified ? 'Verified sender' : 'Unverified sender'}
          </Badge>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs">
            <Link2 className="size-3.5 text-muted" />
            <NativeSelect aria-label="Linked application" className="h-7 w-56 text-xs" value={m.application_id ?? ''} onChange={(e) => update({ application_id: e.target.value || null })}>
              <option value="">Not linked to an application</option>
              {(apps.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.company} — {a.job_title}</option>)}
            </NativeSelect>
          </span>
        </div>
        {m.status_update && (
          <div className={cn('flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-xs', m.status_update.update ? 'bg-jade-soft text-jade' : m.status_update.suggested ? 'bg-amber-soft text-amber' : 'bg-surface-2 text-ink-2')}>
            <span className="min-w-0 flex-1">
              {m.status_update.update
                ? `Application status updated to ${humanize(m.status_update.to)}.`
                : m.status_update.suggested
                  ? `Suggested status: ${humanize(m.status_update.to)}. ${m.status_update.reason}`
                  : `Status not changed: ${m.status_update.reason}`}
              {m.application_id && <> <Link className="font-semibold underline" to={`/applications/${m.application_id}`}>Open application</Link></>}
            </span>
            {m.status_update.suggested && m.application_id && m.status_update.to && (
              <ConfirmDialog
                trigger={<Button size="sm">Apply suggested status</Button>}
                title={`Mark application as ${humanize(m.status_update.to)}?`}
                description={<>This email's sender couldn't be verified, so ApplyPilot didn't change the status itself. Apply it only if you've read the email and trust it.</>}
                confirmLabel={`Mark as ${humanize(m.status_update.to)}`}
                onConfirm={async () => {
                  const to = m.status_update!.to!;
                  const patch: Record<string, unknown> = { status: to, status_source: 'user' };
                  if (to === 'applied') Object.assign(patch, { submitted_at: m.received_at, confirmed_by: 'manual' });
                  const { error } = await supabase.from('applications').update(patch).eq('id', m.application_id!);
                  if (error) return toast.error(error.message);
                  await supabase.from('recruitment_messages').update({ status_update: { ...m.status_update, update: true, suggested: false, reason: 'Applied by you.' } }).eq('id', m.id);
                  toast.success(`Marked as ${humanize(to)}`);
                  onChange();
                }}
              />
            )}
          </div>
        )}
        {c?.summary && (
          <div className="rounded-[var(--radius-control)] border border-line bg-surface-2/50 p-3 text-[13px]">
            <p>{c.summary}</p>
            {c.deadline_iso && <p className="mt-1 text-xs text-amber">Deadline: {formatDateTime(c.deadline_iso)}</p>}
            {c.instructions?.length ? <ul className="mt-1.5 list-disc pl-5 text-xs text-ink-2">{c.instructions.map((i) => <li key={i}>{i}</li>)}</ul> : null}
          </div>
        )}
        <div className="max-h-[420px] overflow-y-auto whitespace-pre-line rounded-[var(--radius-control)] border border-line p-3 text-[13px] leading-relaxed text-ink-2">{m.body_text || m.snippet}</div>
        {m.category !== 'job_alert' && (
          <div className="grid gap-2">
            <p className="text-[13px] font-semibold">Reply {m.suggested_reply && <span className="text-xs font-normal text-muted">— AI draft, edit before sending</span>}</p>
            <Textarea rows={6} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" aria-label="Reply" />
            <ConfirmDialog
              trigger={<Button className="justify-self-start" variant="primary" disabled={!reply.trim()}><Send /> Send reply</Button>}
              title="Send this reply?"
              description={<>Sends from your Gmail to <b>{m.from_email}</b> in the same thread. Automation never sends replies on its own.</>}
              confirmLabel="Send reply"
              onConfirm={() => send.mutateAsync(undefined).then(() => undefined)}
            />
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const [category, setCategory] = React.useState('');
  const [importantOnly, setImportantOnly] = React.useState(false);
  const messages = useMessages({ category: category || undefined, importantOnly });
  const integrations = useIntegrations();
  const qc = useQueryClient();
  const refresh = React.useCallback(() => qc.invalidateQueries({ queryKey: ['messages'] }), [qc]);
  const sync = useAction(() => post<{ fetched: number; alert_jobs: number }>('/integrations/gmail/sync'), { success: (r) => `Fetched ${r.fetched} new email(s)${r.alert_jobs ? `, imported ${r.alert_jobs} job(s) from alerts` : ''}`, invalidate: [['messages'], ['jobs']] });
  const selected = messages.data?.find((m) => m.id === params.get('message')) ?? null;
  const connected = integrations.data?.gmail?.status === 'connected';

  return (
    <>
      <PageHeader
        title="Recruitment inbox"
        description="Recruitment emails from Gmail, classified and linked to your applications. Status changes only happen on clear evidence."
        actions={connected && <Button loading={sync.isPending} onClick={() => sync.mutate(undefined)}><RefreshCw /> Check Gmail now</Button>}
      />
      {integrations.data && !integrations.data.gmail && (
        <div className="mb-4"><EmptyState icon={InboxIcon} title="Gmail is not connected" action={<Button variant="primary" asChild><Link to="/integrations">Connect Gmail</Link></Button>}>Connect with Google to import job alerts and track employer replies. ApplyPilot requests read and draft/send permission; it only sends after you confirm.</EmptyState></div>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <NativeSelect aria-label="Filter category" className="w-48" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {EMAIL_CATEGORIES.map((k) => <option key={k} value={k}>{EMAIL_CATEGORY_LABELS[k]}</option>)}
        </NativeSelect>
        <Button variant={importantOnly ? 'secondary' : 'ghost'} onClick={() => setImportantOnly((v) => !v)} aria-pressed={importantOnly}>Important only</Button>
      </div>
      <ErrorNote error={messages.error} retry={messages.refetch} />
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Panel bodyClassName="p-0">
          {messages.isLoading ? (
            <div className="grid gap-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : !messages.data?.length ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted">No messages.</p>
          ) : (
            <ul className="max-h-[70vh] overflow-y-auto">
              {messages.data.map((m) => (
                <li key={m.id}>
                  <button onClick={() => setParams({ message: m.id })} aria-current={selected?.id === m.id} className={cn('w-full border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-surface-2/60', selected?.id === m.id && 'bg-surface-2')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('truncate text-[13px]', !m.is_read && 'font-semibold')}>{m.from_name || m.from_email}</span>
                      <span className="shrink-0 text-[11px] text-muted">{timeAgo(m.received_at)}</span>
                    </div>
                    <p className="truncate text-xs text-ink-2">{m.subject}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      {m.category ? <Badge tone={tone(m.category)}>{EMAIL_CATEGORY_LABELS[m.category]}</Badge> : <Badge tone="outline">{m.processed_status === 'new' ? 'Waiting for classification' : 'Unclassified'}</Badge>}
                      {m.application_id && <Badge tone="sky">Linked</Badge>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {selected ? <MessageView key={`${selected.id}:${selected.suggested_reply?.length ?? 0}`} m={selected} onChange={refresh} /> : <div className="hidden rounded-[var(--radius-panel)] border border-dashed border-line-strong p-8 text-center text-[13px] text-muted lg:block">Select a message to read it.</div>}
      </div>
    </>
  );
}
