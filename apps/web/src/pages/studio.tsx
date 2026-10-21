import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, PencilLine, ShieldAlert, ShieldCheck, Sparkles, Target, X } from 'lucide-react';
import * as React from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ResumeEditor, ResumeView } from '@/components/resume-editor';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, PageHeader, Panel, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/display';
import { Field, NativeSelect, Textarea } from '@/components/ui/form';
import { keys, useAction, useProfile, useVersions } from '@/hooks/data';
import { post } from '@/lib/api';
import { renderResumePdfLazy, resumeDataSchema, type ResumeData } from '@/lib/resume-tools';
import { check, currentUserId, supabase } from '@/lib/supabase';
import type { ResumeVersion } from '@/lib/types';
import { cn, downloadBytes, humanize, slug, timeAgo } from '@/lib/utils';

function textSet(r: ResumeData): Set<string> {
  return new Set([r.basics.summary, r.basics.headline, ...r.experience.flatMap((e) => e.highlights), ...r.projects.flatMap((p) => p.highlights)].filter(Boolean));
}

function Comparison({ base, candidate, onChanged }: { base: ResumeVersion; candidate: ResumeVersion; onChanged: (id?: string) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<ResumeData>(() => resumeDataSchema.parse(candidate.content));
  const baseData = resumeDataSchema.parse(base.content);
  const candData = resumeDataSchema.parse(candidate.content);
  const baseTexts = textSet(baseData);
  const candTexts = textSet(candData);
  const verify = useAction(() => post(`/resume-versions/${candidate.id}/verify`), { success: 'Verified as your master resume', invalidate: [keys.profile, ['versions'], keys.skills] });

  const setStatus = async (status: 'approved' | 'rejected') => {
    const { error } = await supabase.from('resume_versions').update({ status }).eq('id', candidate.id);
    if (error) return toast.error(error.message);
    toast.success(status === 'approved' ? 'Version approved' : 'Version rejected');
    qc.invalidateQueries({ queryKey: ['versions'] });
  };
  const saveEdits = async () => {
    const { data: last } = await supabase.from('resume_versions').select('version_number').eq('resume_id', candidate.resume_id).order('version_number', { ascending: false }).limit(1);
    const { data, error } = await supabase
      .from('resume_versions')
      .insert({ user_id: await currentUserId(), resume_id: candidate.resume_id, version_number: ((last?.[0]?.version_number as number) ?? 0) + 1, kind: candidate.kind === 'tailored' ? 'tailored' : 'manual', job_id: candidate.job_id, label: `${candidate.label} (edited)`, content: draft, based_on_version_id: candidate.id, status: 'approved' })
      .select('id')
      .single();
    if (error) return toast.error(error.message);
    toast.success('Edited version saved and approved');
    setEditing(false);
    qc.invalidateQueries({ queryKey: ['versions'] });
    onChanged(data.id as string);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-semibold">{candidate.label}</span>
          <Badge tone={candidate.status === 'approved' ? 'jade' : candidate.status === 'rejected' ? 'rose' : 'amber'}>{humanize(candidate.status)}</Badge>
          <span className="text-xs text-muted">v{candidate.version_number} · {candidate.model ?? 'manual'} · {timeAgo(candidate.created_at)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={async () => downloadBytes(await renderResumePdfLazy(candData), `${slug(candData.basics.name || 'resume')}-${slug(candidate.label)}.pdf`)}><Download /> Export PDF</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}><PencilLine /> {editing ? 'Cancel editing' : 'Edit manually'}</Button>
          {candidate.status !== 'rejected' && <Button size="sm" variant="ghost" onClick={() => setStatus('rejected')}><X /> Reject</Button>}
          {candidate.status !== 'approved' && <Button size="sm" onClick={() => setStatus('approved')}><Check /> Approve changes</Button>}
          {candidate.kind !== 'tailored' && <Button size="sm" variant="primary" loading={verify.isPending} onClick={() => verify.mutate(undefined)}><ShieldCheck /> Use as master resume</Button>}
        </div>
      </div>

      {candidate.guard_violations?.length > 0 && (
        <Panel title={`Fabrication guard removed or restored ${candidate.guard_violations.length} item(s)`} description="These AI changes were not supported by your verified resume, so they were undone automatically.">
          <ul className="grid gap-1.5 text-[13px]">
            {candidate.guard_violations.map((v, i) => (
              <li key={i} className="flex gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber" />
                <span><span className="font-medium">{humanize(v.action)} · {v.section}:</span> {v.item} <span className="text-muted">— {v.reason}</span></span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {editing ? (
        <Panel title="Edit before approving" actions={<Button size="sm" variant="primary" onClick={saveEdits}>Save edited version</Button>}>
          <ResumeEditor value={draft} onChange={setDraft} />
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Original" description={`v${base.version_number} · ${base.label || humanize(base.kind)}`}>
            <ResumeView value={baseData} highlight={(t) => !candTexts.has(t)} />
          </Panel>
          <Panel title="AI version" description="Highlighted text is new or reworded">
            <ResumeView value={candData} highlight={(t) => !baseTexts.has(t)} />
          </Panel>
        </div>
      )}

      {candidate.ai_changes?.length > 0 && (
        <Panel title={`Change log (${candidate.ai_changes.length})`} bodyClassName="p-0">
          <ul>
            {candidate.ai_changes.map((c, i) => (
              <li key={i} className="grid gap-1 border-b border-line px-4 py-3 text-[13px] last:border-0 md:grid-cols-[120px_1fr_1fr]">
                <span className="text-xs font-medium text-muted">{c.section}</span>
                <span className="text-ink-2 line-through decoration-rose/50">{c.before || '—'}</span>
                <span>
                  {c.after || '—'}
                  {c.reason && <span className="mt-0.5 block text-xs text-muted">{c.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

export default function Studio() {
  const [params, setParams] = useSearchParams();
  const profile = useProfile();
  const versions = useVersions();
  const all = versions.data ?? [];
  const masters = all.filter((v) => v.kind !== 'tailored');
  const verifiedId = profile.data?.verified_resume_version_id ?? null;
  const [baseId, setBaseId] = React.useState<string | null>(null);
  const base = masters.find((v) => v.id === baseId) ?? masters.find((v) => v.id === verifiedId) ?? masters[0];
  const [candidateId, setCandidateId] = React.useState<string | null>(params.get('version'));
  const aiVersions = all.filter((v) => v.kind === 'ai_enhanced' || v.kind === 'tailored' || (v.kind === 'manual' && v.based_on_version_id));
  const candidate = all.find((v) => v.id === candidateId) ?? null;
  const candidateBase = candidate ? (all.find((v) => v.id === candidate.based_on_version_id) ?? base) : null;
  const [instructions, setInstructions] = React.useState('');
  const [jobId, setJobId] = React.useState(params.get('job') ?? '');
  const [tab, setTab] = React.useState(params.get('job') ? 'tailor' : candidateId ? 'compare' : 'enhance');

  const jobs = useQuery({
    queryKey: ['jobs', 'studio-picker'],
    queryFn: async () => check(await supabase.from('job_listings').select('id, title, company, job_matches(score)').eq('status', 'active').eq('is_hidden', false).order('discovered_at', { ascending: false }).limit(100), 'jobs') as Array<{ id: string; title: string; company: string; job_matches: Array<{ score: number | null }> }>,
  });
  const openCompare = (id: string) => {
    setCandidateId(id);
    setTab('compare');
    setParams({ version: id }, { replace: true });
  };
  const enhance = useAction(() => post<{ version: { id: string }; violations: unknown[] }>(`/resume-versions/${base!.id}/enhance`, { instructions: instructions || undefined }), {
    success: (r) => `Enhanced version ready${r.violations.length ? ` — guard undid ${r.violations.length} unsupported change(s)` : ''}`,
    invalidate: [['versions']],
    onSuccess: (r) => openCompare(r.version.id),
  });
  const tailor = useAction(() => post<{ version: { id: string }; violations: unknown[] }>(`/resume-versions/${base!.id}/tailor`, { job_id: jobId }), {
    success: (r) => `Tailored version ready${r.violations.length ? ` — guard undid ${r.violations.length} unsupported change(s)` : ''}`,
    invalidate: [['versions']],
    onSuccess: (r) => openCompare(r.version.id),
  });

  if (versions.isLoading) return <Skeleton className="h-96" />;
  if (!masters.length) {
    return (
      <>
        <PageHeader title="Resume studio" />
        <EmptyState icon={Sparkles} title="Upload a resume first" action={<Button variant="primary" asChild><Link to="/resume">Go to My resume</Link></Button>}>
          The studio rewrites an existing, verified resume. It never invents experience.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Resume studio" description="Improve wording or tailor to a job. Every AI result passes a fabrication guard and waits for your approval." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="enhance">General enhancement</TabsTrigger>
          <TabsTrigger value="tailor">Tailor to a job</TabsTrigger>
          <TabsTrigger value="compare">Compare versions{aiVersions.length ? ` (${aiVersions.length})` : ''}</TabsTrigger>
        </TabsList>

        <div className="mb-4 max-w-md">
          <Field label="Source version" hint={base?.id === verifiedId ? 'Your verified resume' : 'Not your verified resume — verify it first for best results'}>
            <NativeSelect value={base?.id} onChange={(e) => setBaseId(e.target.value)}>
              {masters.map((v) => <option key={v.id} value={v.id}>v{v.version_number} · {v.label || humanize(v.kind)}{v.id === verifiedId ? ' (verified)' : ''}</option>)}
            </NativeSelect>
          </Field>
        </div>

        <TabsContent value="enhance">
          <Panel title="General enhancement" description="Clearer structure, stronger verbs, concise ATS-friendly bullets — using only facts already in your resume.">
            <div className="grid max-w-2xl gap-3">
              <Field label="Focus (optional)" hint="For example: shorten bullets, emphasize backend work, make the summary target internships">
                <Textarea rows={3} maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              </Field>
              <Button variant="primary" className="justify-self-start" loading={enhance.isPending} onClick={() => enhance.mutate(undefined)}>
                <Sparkles /> Enhance resume
              </Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="tailor">
          <Panel title="Job-specific tailoring" description="Reorders and rewords your real experience to match the posting. Skills you don't have are never added.">
            <div className="grid max-w-2xl gap-3">
              <Field label="Target job">
                <NativeSelect value={jobId} onChange={(e) => setJobId(e.target.value)}>
                  <option value="">Choose a job…</option>
                  {(jobs.data ?? []).map((j) => <option key={j.id} value={j.id}>{j.job_matches[0]?.score != null ? `${j.job_matches[0].score}% · ` : ''}{j.title} — {j.company}</option>)}
                </NativeSelect>
              </Field>
              <Button variant="primary" className="justify-self-start" disabled={!jobId} loading={tailor.isPending} onClick={() => tailor.mutate(undefined)}>
                <Target /> Tailor resume
              </Button>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="compare">
          <div className="grid gap-4">
            {aiVersions.length === 0 ? (
              <EmptyState icon={Sparkles} title="No AI versions yet">Run an enhancement or tailoring to compare it with the original.</EmptyState>
            ) : (
              <div className="max-w-md">
                <Field label="Version to review">
                  <NativeSelect value={candidate?.id ?? ''} onChange={(e) => openCompare(e.target.value)}>
                    <option value="">Choose a version…</option>
                    {aiVersions.map((v) => <option key={v.id} value={v.id}>v{v.version_number} · {v.label} · {humanize(v.status)}</option>)}
                  </NativeSelect>
                </Field>
              </div>
            )}
            {candidate && candidateBase && <Comparison key={candidate.id} base={candidateBase} candidate={candidate} onChanged={(id) => id && openCompare(id)} />}
          </div>
        </TabsContent>
      </Tabs>
      <p className={cn('mt-6 text-xs text-muted')}>Free-tier Gemini requests are limited. Each enhancement or tailoring uses one request from your daily AI budget.</p>
    </>
  );
}
