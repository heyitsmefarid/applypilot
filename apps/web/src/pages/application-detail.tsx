import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCheck, Download, ExternalLink, FileCheck2, Hand, ImageIcon, Mail, PlayCircle, Send, ShieldCheck, Wand2 } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/domain';
import { ResumeView } from '@/components/resume-editor';
import { Button } from '@/components/ui/button';
import { Badge, ErrorNote, Panel, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/display';
import { Field, Input, Textarea } from '@/components/ui/form';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/overlay';
import { keys, useAction, useApplication, useProfile, useRules } from '@/hooks/data';
import { api, post } from '@/lib/api';
import { renderLetterPdfLazy, renderResumePdfLazy, resumeDataSchema } from '@/lib/resume-tools';
import { check, supabase } from '@/lib/supabase';
import type { ApplicationDocument, ResumeVersion } from '@/lib/types';
import { cn, downloadBytes, errorMessage, formatDate, formatDateTime, humanize, slug, timeAgo } from '@/lib/utils';

function DocEditor({ doc, onSaved }: { doc: ApplicationDocument; onSaved: () => void }) {
  const [text, setText] = React.useState(doc.content_text);
  const [title, setTitle] = React.useState(doc.title);
  const dirty = text !== doc.content_text || title !== doc.title;
  const save = async () => {
    const { error } = await supabase.from('application_documents').update({ content_text: text, title, status: doc.status === 'approved' ? 'draft' : doc.status }).eq('id', doc.id);
    if (error) return toast.error(error.message);
    toast.success('Saved. Approve the documents again before submitting.');
    onSaved();
  };
  return (
    <div className="grid gap-3">
      {(doc.kind === 'email' || doc.kind === 'follow_up') && (
        <Field label="Subject"><Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={doc.status === 'sent'} /></Field>
      )}
      <Textarea rows={doc.kind === 'cover_letter' ? 16 : 10} value={text} onChange={(e) => setText(e.target.value)} disabled={doc.status === 'sent'} aria-label={`${humanize(doc.kind)} text`} className="font-[inherit] text-[13.5px]" />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={doc.status === 'approved' ? 'jade' : doc.status === 'sent' ? 'sky' : 'amber'}>{humanize(doc.status)}</Badge>
        <span className="text-xs text-muted">v{doc.version}{doc.model ? ` · ${doc.model}` : ''} · {timeAgo(doc.created_at)}</span>
        {dirty && <Button size="sm" className="ml-auto" onClick={save}>Save changes</Button>}
      </div>
    </div>
  );
}

function SendEmailDialog({ doc, defaultTo, onSent }: { doc: ApplicationDocument; defaultTo: string; onSent: () => void }) {
  const [to, setTo] = React.useState(defaultTo);
  const [open, setOpen] = React.useState(false);
  const send = useAction(() => post(`/documents/${doc.id}/send`, { to, confirm: true }), { success: `Sent to ${to}`, onSuccess: () => { setOpen(false); onSent(); } });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={doc.status === 'sent'}><Send /> {doc.status === 'sent' ? 'Sent' : 'Send with Gmail'}</Button>
      </DialogTrigger>
      <DialogContent title="Send this email?" description="It is sent from your connected Gmail account exactly as written. Nothing is ever sent without this confirmation.">
        <Field label="To"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="recruiter@company.com" /></Field>
        <div className="rounded-[var(--radius-control)] border border-line bg-surface-2/60 p-3 text-[13px]">
          <p className="font-semibold">{doc.title}</p>
          <p className="mt-1 line-clamp-6 whitespace-pre-line text-ink-2">{doc.content_text}</p>
        </div>
        <DialogFooter>
          <Button variant="primary" disabled={!/^\S+@\S+\.\S+$/.test(to)} loading={send.isPending} onClick={() => send.mutate(undefined)}>Send email</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Evidence({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['evidence', id], queryFn: () => api<{ evidence: Record<string, unknown> | null; screenshots: Array<{ path: string; url: string | null }> }>(`/applications/${id}/evidence`) });
  if (isLoading) return <Skeleton className="h-24" />;
  if (!data?.screenshots.length && !data?.evidence) return <p className="text-[13px] text-muted">No automation evidence yet. Screenshots from prefill and submission runs appear here.</p>;
  const ev = data.evidence as { confirmation_text?: string; confirmation_id?: string; final_url?: string; recorded_at?: string } | null;
  return (
    <div className="grid gap-3">
      {ev && (
        <dl className="grid gap-1 text-[13px]">
          {ev.confirmation_id && <div><dt className="inline text-muted">Confirmation reference: </dt><dd className="inline font-semibold">{ev.confirmation_id}</dd></div>}
          {ev.confirmation_text && <div><dt className="inline text-muted">Confirmation message: </dt><dd className="inline">{ev.confirmation_text}</dd></div>}
          {ev.recorded_at && <div><dt className="inline text-muted">Recorded: </dt><dd className="inline">{formatDateTime(ev.recorded_at)}</dd></div>}
        </dl>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {data.screenshots.map((s) =>
          s.url ? (
            <a key={s.path} href={s.url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-[var(--radius-control)] border border-line hover:border-jade">
              <img src={s.url} alt={`Automation screenshot ${s.path.split('/').pop()}`} className="aspect-video w-full object-cover object-top" loading="lazy" />
            </a>
          ) : (
            <span key={s.path} className="flex items-center gap-2 text-xs text-muted"><ImageIcon className="size-4" /> {s.path.split('/').pop()}</span>
          ),
        )}
      </div>
    </div>
  );
}

export default function ApplicationDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApplication(id);
  const rules = useRules();
  const profile = useProfile();
  const app = data?.application;
  const resumeVersion = useQuery({
    queryKey: ['resume-version', app?.resume_version_id],
    enabled: Boolean(app?.resume_version_id),
    queryFn: async () => check(await supabase.from('resume_versions').select('*').eq('id', app!.resume_version_id!).single(), 'resume version') as ResumeVersion,
  });
  const invalidate = [keys.application(id), keys.applications];
  const prepare = useAction(() => post('/applications/prepare', { job_id: app!.job_id }), { success: 'Documents generated', invalidate });
  const approveDocs = useAction(() => post(`/applications/${id}/approve-documents`), { success: 'Documents approved', invalidate });
  const prefill = useAction(() => post(`/applications/${id}/prefill`), { success: 'Prefill queued — screenshots appear under Evidence when the runner finishes', invalidate: [...invalidate, ['runs']] });
  const submit = useAction(() => post(`/applications/${id}/approve-submission`), { success: 'Submission approved and queued', invalidate: [...invalidate, ['runs']] });
  const confirm = useAction(() => post(`/applications/${id}/confirm-submitted`, {}), { success: 'Marked as applied', invalidate });
  const [notes, setNotes] = React.useState<string | null>(null);

  if (isLoading) return <div className="grid gap-4"><Skeleton className="h-28" /><Skeleton className="h-96" /></div>;
  if (error || !app || !data) return <ErrorNote error={error ?? new Error('Application not found')} retry={refetch} />;

  const docs = data.documents;
  const latest = (kind: ApplicationDocument['kind']) => docs.find((d) => d.kind === kind);
  const coverLetter = latest('cover_letter');
  const email = latest('email');
  const screening = latest('screening_answers');
  const followUps = docs.filter((d) => d.kind === 'follow_up');
  const drafts = docs.filter((d) => d.status === 'draft' && d.kind !== 'follow_up');
  const submitted = ['applied', 'assessment', 'interview', 'offer', 'rejected'].includes(app.status);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.application(id) });
  const name = profile.data?.full_name || 'applicant';

  return (
    <div className="grid gap-4">
      <button onClick={() => navigate(-1)} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" /> Back</button>
      <header className="grid gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-5 md:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-display text-[24px]">{app.job_title}</h1>
            <StatusBadge status={app.status} />
            {app.needs_manual_action && <Badge tone="amber"><Hand /> Manual action</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {app.company}
            {app.job_id && <> · <Link to={`/jobs/${app.job_id}`} className="text-jade hover:underline">job details</Link></>}
            {app.apply_url && <> · <a href={app.apply_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-jade hover:underline">original posting <ExternalLink className="size-3" /></a></>}
          </p>
          <p className="mt-1 text-xs text-muted">Mode {humanize(app.mode)} · channel {humanize(app.channel)} · match {app.match_score ?? '—'}% · submitted {formatDate(app.submitted_at)}{app.confirmed_by ? ` (${app.confirmed_by === 'evidence' ? 'verified by evidence' : app.confirmed_by === 'email' ? 'confirmed by employer email' : 'confirmed by you'})` : ''}</p>
          {app.manual_action_reason && <p className="mt-2 rounded-[var(--radius-control)] bg-amber-soft px-2.5 py-1.5 text-xs text-amber">{app.manual_action_reason}</p>}
          {app.last_error && <p className="mt-2 rounded-[var(--radius-control)] bg-rose-soft px-2.5 py-1.5 text-xs text-rose">{app.last_error}</p>}
        </div>
        {!submitted && (
          <div className="flex flex-wrap content-start gap-2 md:max-w-xs md:justify-end">
            {!docs.length && app.job_id && <Button variant="primary" loading={prepare.isPending} onClick={() => prepare.mutate(undefined)}><Wand2 /> Prepare documents</Button>}
            {drafts.length > 0 && <Button variant="primary" loading={approveDocs.isPending} onClick={() => approveDocs.mutate(undefined)}><FileCheck2 /> Approve documents</Button>}
            {app.documents_approved_at && rules.data?.mode !== 'manual' && (
              <>
                <Button loading={prefill.isPending} onClick={() => prefill.mutate(undefined)}><PlayCircle /> Fill form for review</Button>
                <ConfirmDialog
                  trigger={<Button variant="primary"><ShieldCheck /> Approve & submit</Button>}
                  title="Submit this application?"
                  description={<>The Playwright runner fills the form at <b>{app.apply_url}</b> with your approved documents and submits it. It stops if it meets a CAPTCHA, and the application is marked applied only when a confirmation is captured.</>}
                  confirmLabel="Submit application"
                  onConfirm={() => submit.mutateAsync(undefined).then(() => undefined)}
                />
              </>
            )}
            <ConfirmDialog
              trigger={<Button variant="ghost"><CheckCheck /> I applied myself</Button>}
              title="Confirm manual submission"
              description="Mark this application as applied because you submitted it yourself on the employer's site."
              confirmLabel="Confirm submission"
              onConfirm={() => confirm.mutateAsync(undefined).then(() => undefined)}
            />
          </div>
        )}
      </header>
      {prepare.isPending && <p className="rounded-[var(--radius-control)] bg-sky-soft px-3 py-2 text-[13px] text-sky">Generating your tailored resume, cover letter, email and screening answers…</p>}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Application documents" description={app.documents_approved_at ? `Approved ${timeAgo(app.documents_approved_at)}` : 'Review and edit before approving'} bodyClassName="p-0">
          {!docs.length && !resumeVersion.data ? (
            <p className="p-4 text-[13px] text-muted">No documents yet. Prepare them with Gemini, or apply with your verified resume.</p>
          ) : (
            <Tabs defaultValue="resume">
              <TabsList className="w-full overflow-x-auto px-3">
                <TabsTrigger value="resume">Resume</TabsTrigger>
                <TabsTrigger value="cover">Cover letter</TabsTrigger>
                <TabsTrigger value="email">Email</TabsTrigger>
                <TabsTrigger value="screening">Screening answers</TabsTrigger>
                <TabsTrigger value="followups">Follow-ups{followUps.length ? ` (${followUps.length})` : ''}</TabsTrigger>
              </TabsList>
              <div className="p-4">
                <TabsContent value="resume">
                  {resumeVersion.data ? (
                    <div className="grid gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={resumeVersion.data.status === 'approved' ? 'jade' : 'amber'}>{humanize(resumeVersion.data.status)}</Badge>
                        <span className="text-xs text-muted">{resumeVersion.data.label}</span>
                        {resumeVersion.data.guard_violations?.length > 0 && <Badge tone="amber">Guard undid {resumeVersion.data.guard_violations.length}</Badge>}
                        <div className="ml-auto flex gap-1">
                          <Button size="sm" variant="ghost" asChild><Link to={`/studio?version=${resumeVersion.data.id}`}>Compare & edit</Link></Button>
                          <Button size="sm" variant="ghost" onClick={async () => downloadBytes(await renderResumePdfLazy(resumeDataSchema.parse(resumeVersion.data!.content)), `${slug(name)}-resume-${slug(app.company)}.pdf`)}><Download /> PDF</Button>
                        </div>
                      </div>
                      <div className="max-h-[520px] overflow-y-auto rounded-[var(--radius-control)] border border-line p-4">
                        <ResumeView value={resumeDataSchema.parse(resumeVersion.data.content)} />
                      </div>
                    </div>
                  ) : <p className="text-[13px] text-muted">No tailored resume — your verified resume will be used.</p>}
                </TabsContent>
                <TabsContent value="cover">
                  {coverLetter ? (
                    <div className="grid gap-2">
                      <DocEditor key={coverLetter.id} doc={coverLetter} onSaved={refresh} />
                      <Button size="sm" variant="ghost" className="justify-self-start" onClick={async () => {
                        const paras = coverLetter.content_text.split(/\n{2,}/);
                        const bytes = await renderLetterPdfLazy({ senderName: name, senderContact: [profile.data?.email ?? '', profile.data?.phone ?? '', profile.data?.location ?? ''], date: formatDate(new Date().toISOString(), { dateStyle: 'long' }), greeting: paras[0] ?? '', paragraphs: paras.slice(1, -1), closing: (paras.at(-1) ?? '').split('\n')[0] ?? 'Sincerely,', signature: name });
                        downloadBytes(bytes, `${slug(name)}-cover-letter-${slug(app.company)}.pdf`);
                      }}><Download /> Export PDF</Button>
                    </div>
                  ) : <p className="text-[13px] text-muted">No cover letter generated.</p>}
                </TabsContent>
                <TabsContent value="email">
                  {email ? (
                    <div className="grid gap-2">
                      <DocEditor key={email.id} doc={email} onSaved={refresh} />
                      <div className="flex gap-2"><SendEmailDialog doc={email} defaultTo={app.recruiter_email ?? ''} onSent={refresh} /></div>
                    </div>
                  ) : <p className="text-[13px] text-muted">No application email generated.</p>}
                </TabsContent>
                <TabsContent value="screening">
                  {screening ? <DocEditor key={screening.id} doc={screening} onSaved={refresh} /> : <p className="text-[13px] text-muted">No screening answers generated.</p>}
                </TabsContent>
                <TabsContent value="followups">
                  {followUps.length === 0 ? (
                    <p className="text-[13px] text-muted">Follow-up drafts appear here when an application has no response after {app.follow_up_interval_days ?? rules.data?.follow_up_after_days ?? 7} days.</p>
                  ) : (
                    <div className="grid gap-5">
                      {followUps.map((f) => (
                        <div key={f.id} className="grid gap-2">
                          <DocEditor doc={f} onSaved={refresh} />
                          <div><SendEmailDialog doc={f} defaultTo={app.recruiter_email ?? ((f.content_json?.to as string) || '')} onSent={refresh} /></div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </div>
            </Tabs>
          )}
        </Panel>

        <div className="grid content-start gap-4">
          <Panel title="Evidence"><Evidence id={id} /></Panel>
          <Panel title="Details">
            <div className="grid gap-3">
              <Field label="Notes">
                <Textarea rows={3} value={notes ?? app.notes} onChange={(e) => setNotes(e.target.value)} onBlur={async () => {
                  if (notes === null || notes === app.notes) return;
                  const { error: e } = await supabase.from('applications').update({ notes }).eq('id', id);
                  if (e) toast.error(e.message);
                  else refresh();
                }} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Recruiter email"><Input type="email" defaultValue={app.recruiter_email ?? ''} onBlur={async (e) => { await supabase.from('applications').update({ recruiter_email: e.target.value || null }).eq('id', id); refresh(); }} /></Field>
                <Field label="Follow up after (days)"><Input type="number" min={1} max={60} defaultValue={app.follow_up_interval_days ?? ''} onBlur={async (e) => {
                  const n = Number(e.target.value);
                  if (n >= 1 && n <= 60) await supabase.from('applications').update({ follow_up_interval_days: n }).eq('id', id).then(({ error: err }) => err && toast.error(errorMessage(err)));
                }} /></Field>
              </div>
              <Field
                label="Company email domain"
                hint="Only Gmail-verified mail from this exact domain (e.g. acme.com) may update this application's status on its own. Other recruitment email is shown as a suggestion."
              >
                <Input
                  placeholder="acme.com"
                  defaultValue={app.company_domain ?? ''}
                  onBlur={async (e) => {
                    const v = e.target.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
                    if (v === (app.company_domain ?? '')) return;
                    if (v && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return toast.error('Enter a domain like acme.com');
                    const { error: err } = await supabase.from('applications').update({ company_domain: v || null }).eq('id', id);
                    if (err) toast.error(errorMessage(err));
                    else refresh();
                  }}
                />
              </Field>
            </div>
          </Panel>
          {(data.messages.length > 0 || data.interviews.length > 0) && (
            <Panel title="Linked emails & interviews">
              <ul className="grid gap-2 text-[13px]">
                {data.interviews.map((i) => <li key={i.id} className="flex items-center gap-2"><Badge tone="jade">Interview</Badge>{i.scheduled_at ? formatDateTime(i.scheduled_at) : 'Time to confirm'}</li>)}
                {data.messages.map((m) => (
                  <li key={m.id}><Link to={`/inbox?message=${m.id}`} className="flex items-center gap-2 hover:text-jade"><Mail className="size-3.5 text-muted" /><span className="truncate">{m.subject}</span><span className="ml-auto shrink-0 text-xs text-muted">{timeAgo(m.received_at)}</span></Link></li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Status history & audit trail" bodyClassName="p-0">
            <ol className="max-h-[420px] overflow-y-auto">
              {data.events.map((e) => (
                <li key={e.id} className="border-b border-line px-4 py-2.5 text-[13px] last:border-0">
                  <div className="flex items-center gap-2">
                    <span className={cn('size-1.5 shrink-0 rounded-full', e.type === 'status_change' ? 'bg-jade' : e.type === 'automation' ? 'bg-sky' : e.type === 'email' ? 'bg-amber' : 'bg-muted')} aria-hidden />
                    <span className="min-w-0 flex-1">{e.message}</span>
                  </div>
                  <p className="pl-3.5 text-[11px] text-muted">{humanize(e.actor)} · {formatDateTime(e.created_at)}</p>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}
