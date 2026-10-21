import { normalizeSkill, renderResumePdfLazy, resumeDataSchema, type ResumeData } from '@/lib/resume-tools';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Download, Eye, FileText, FileUp, Gauge, RefreshCw, ShieldCheck, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ResumeEditor } from '@/components/resume-editor';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorNote, Meter, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { ConfirmDialog } from '@/components/ui/overlay';
import { keys, useAction, useProfile, useResumes, useSkills, useVersions } from '@/hooks/data';
import { post } from '@/lib/api';
import { DOCX, extractResumeText, MAX_RESUME_BYTES, PDF } from '@/lib/extract-text';
import { currentUserId, supabase } from '@/lib/supabase';
import type { Resume, ResumeVersion } from '@/lib/types';
import { cn, downloadBytes, errorMessage, formatDateTime, humanize, slug, timeAgo } from '@/lib/utils';

async function uploadFile(file: File, existing?: Resume): Promise<string> {
  if (![PDF, DOCX].includes(file.type) && !/\.(pdf|docx)$/i.test(file.name)) throw new Error('Upload a PDF or DOCX file.');
  if (file.size > MAX_RESUME_BYTES) throw new Error('Resume files must be 10 MB or smaller.');
  const text = await extractResumeText(file);
  if (text.length < 50) throw new Error('No readable text was found. Scanned images are not supported — export a text-based PDF.');
  const uid = await currentUserId();
  const path = `${uid}/${crypto.randomUUID()}-${slug(file.name.replace(/\.(pdf|docx)$/i, ''))}.${file.name.toLowerCase().endsWith('.docx') ? 'docx' : 'pdf'}`;
  const mime = file.name.toLowerCase().endsWith('.docx') ? DOCX : PDF;
  const up = await supabase.storage.from('resumes').upload(path, file, { contentType: mime, upsert: false });
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
  const row = { file_path: path, file_name: file.name, mime_type: mime, file_size: file.size, extracted_text: text, status: 'uploaded', analysis: null, analysis_error: null };
  if (existing) {
    const { error } = await supabase.from('resumes').update(row).eq('id', existing.id);
    if (error) throw new Error(error.message);
    await supabase.storage.from('resumes').remove([existing.file_path]);
    return existing.id;
  }
  const { data, error } = await supabase.from('resumes').insert({ ...row, user_id: uid, title: file.name.replace(/\.(pdf|docx)$/i, '').slice(0, 160) }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

function UploadZone({ onUploaded, replacing, compact }: { onUploaded: (id: string) => void; replacing?: Resume; compact?: boolean }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const handle = async (file?: File | null) => {
    if (!file) return;
    try {
      setBusy('Reading your resume…');
      const id = await uploadFile(file, replacing);
      setBusy('Extracting details with Gemini…');
      try {
        await post(`/resumes/${id}/extract`);
        toast.success('Resume extracted. Review the details, then verify them.');
      } catch (e) {
        toast.warning(`Uploaded, but AI extraction failed: ${errorMessage(e)}. You can retry or enter details manually.`);
      }
      onUploaded(id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };
  if (compact) {
    return (
      <>
        <input ref={input} type="file" accept=".pdf,.docx" className="sr-only" onChange={(e) => handle(e.target.files?.[0])} aria-label="Replace resume file" />
        <Button size="sm" variant="ghost" loading={Boolean(busy)} onClick={() => input.current?.click()}>
          <RefreshCw /> {busy ?? 'Replace file'}
        </Button>
      </>
    );
  }
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
      className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-panel)] border border-dashed border-line-strong bg-surface px-6 py-8 text-center hover:border-jade', drag && 'border-jade bg-jade-soft/40')}
    >
      <input ref={input} type="file" accept=".pdf,.docx" className="sr-only" onChange={(e) => handle(e.target.files?.[0])} disabled={Boolean(busy)} />
      {busy ? <RefreshCw className="size-5 animate-spin text-jade" /> : <Upload className="size-5 text-muted" />}
      <span className="text-[14px] font-semibold">{busy ?? 'Upload a resume'}</span>
      <span className="text-xs text-muted">PDF or DOCX up to 10 MB. Files are stored privately in your Supabase bucket.</span>
    </label>
  );
}

function AnalysisPanel({ resume }: { resume: Resume }) {
  const qc = useQueryClient();
  const analyze = useAction(() => post(`/resumes/${resume.id}/analyze`), { success: 'Analysis updated', onSuccess: () => qc.invalidateQueries({ queryKey: keys.resumes }) });
  const a = resume.analysis;
  return (
    <Panel
      title="Completeness & quality"
      description={a ? `Analyzed ${timeAgo(a.analyzed_at)}${a.model ? ` with ${a.model}` : ' (rules only)'}` : 'Not analyzed yet'}
      actions={<Button size="sm" loading={analyze.isPending} onClick={() => analyze.mutate(undefined)}><Gauge /> {a ? 'Re-analyze' : 'Analyze'}</Button>}
    >
      {!a ? (
        <p className="text-[13px] text-muted">Checks for missing sections and asks Gemini for concrete wording and ATS improvements.</p>
      ) : (
        <div className="grid gap-4 text-[13px]">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted">Completeness</p>
              <p className="type-display figures text-[28px]">{a.completeness.score}</p>
              <Meter value={a.completeness.score} label="Completeness" tone={a.completeness.score >= 75 ? 'jade' : 'amber'} />
            </div>
            <div>
              <p className="text-xs text-muted">AI quality score</p>
              <p className="type-display figures text-[28px]">{a.ai?.overall_score ?? '—'}</p>
              {a.ai && <Meter value={a.ai.overall_score} label="Quality" tone={a.ai.overall_score >= 75 ? 'jade' : 'amber'} />}
            </div>
          </div>
          {a.ai_error && <p className="text-xs text-amber">AI review unavailable: {a.ai_error}</p>}
          {a.ai?.summary && <p className="text-ink-2">{a.ai.summary}</p>}
          {a.completeness.missing.length > 0 && (
            <div>
              <p className="mb-1 font-semibold">Missing information to add yourself</p>
              <ul className="list-disc space-y-0.5 pl-5 text-ink-2">{[...a.completeness.missing, ...(a.ai?.missing_information ?? [])].map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          )}
          {a.ai?.issues?.length ? (
            <div>
              <p className="mb-1.5 font-semibold">Suggested improvements</p>
              <ul className="grid gap-2">
                {a.ai.issues.map((i, n) => (
                  <li key={n} className="rounded-[var(--radius-control)] border border-line p-2.5">
                    <div className="flex items-center gap-2">
                      <Badge tone={i.severity === 'high' ? 'rose' : i.severity === 'medium' ? 'amber' : 'neutral'}>{humanize(i.severity)}</Badge>
                      <span className="text-xs text-muted">{i.section}</span>
                    </div>
                    <p className="mt-1">{i.issue}</p>
                    <p className="mt-0.5 text-ink-2">{i.suggestion}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {[...a.completeness.warnings, ...(a.ai?.ats_tips ?? [])].length > 0 && (
            <div>
              <p className="mb-1 font-semibold">ATS tips</p>
              <ul className="list-disc space-y-0.5 pl-5 text-ink-2">{[...a.completeness.warnings, ...(a.ai?.ats_tips ?? [])].map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          )}
          <Button variant="link" size="sm" asChild className="justify-self-start">
            <Link to="/studio"><Wand2 className="size-3.5" /> Improve wording in the resume studio</Link>
          </Button>
        </div>
      )}
    </Panel>
  );
}

function VersionEditor({ version, verifiedId, onSaved }: { version: ResumeVersion; verifiedId: string | null; onSaved: (id: string) => void }) {
  const [draft, setDraft] = React.useState<ResumeData>(() => resumeDataSchema.parse(version.content));
  const [dirty, setDirty] = React.useState(false);
  const qc = useQueryClient();
  const verify = useAction((id: string) => post(`/resume-versions/${id}/verify`), {
    success: 'Verified. Matching and tailoring now use this version.',
    invalidate: [keys.profile, keys.versions(), keys.versions(version.resume_id), keys.skills],
  });
  const saveAsNew = async (andVerify: boolean) => {
    try {
      const { data: last } = await supabase.from('resume_versions').select('version_number').eq('resume_id', version.resume_id).order('version_number', { ascending: false }).limit(1);
      const { data, error } = await supabase
        .from('resume_versions')
        .insert({ user_id: await currentUserId(), resume_id: version.resume_id, version_number: ((last?.[0]?.version_number as number) ?? 0) + 1, kind: 'manual', label: 'Manually corrected', content: draft, based_on_version_id: version.id })
        .select('id')
        .single();
      if (error) throw error;
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['versions'] });
      onSaved(data.id as string);
      if (andVerify) await verify.mutateAsync(data.id as string);
      else toast.success('Saved as a new version');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const isVerified = version.id === verifiedId;
  return (
    <Panel
      title={`Version ${version.version_number}: ${version.label || humanize(version.kind)}`}
      description={isVerified ? 'This is your verified resume — the source of truth for matching and tailoring.' : 'Review every field. AI extraction can misread columns or dates.'}
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={async () => downloadBytes(await renderResumePdfLazy(draft), `${slug(draft.basics.name || 'resume')}-resume.pdf`)}>
            <Download /> Export PDF
          </Button>
          {dirty ? (
            <>
              <Button size="sm" onClick={() => saveAsNew(false)}>Save as new version</Button>
              <Button size="sm" variant="primary" onClick={() => saveAsNew(true)}><ShieldCheck /> Save and verify</Button>
            </>
          ) : (
            !isVerified && version.kind !== 'tailored' && (
              <Button size="sm" variant="primary" loading={verify.isPending} onClick={() => verify.mutate(version.id)}>
                <ShieldCheck /> Verify this version
              </Button>
            )
          )}
        </>
      }
    >
      {version.ai_changes?.length > 0 && version.kind === 'extracted' && (
        <div className="mb-4 rounded-[var(--radius-control)] border border-amber/40 bg-amber-soft/60 p-3 text-xs text-amber">
          <p className="font-semibold">Extraction notes</p>
          <ul className="mt-1 list-disc pl-4">{version.ai_changes.map((c, i) => <li key={i}>{c.reason}</li>)}</ul>
        </div>
      )}
      <ResumeEditor value={draft} onChange={(r) => { setDraft(r); setDirty(true); }} />
    </Panel>
  );
}

function SkillsPanel() {
  const { data = [], isLoading } = useSkills();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const add = async () => {
    if (!name.trim()) return;
    const { error } = await supabase.from('skills').upsert({ user_id: await currentUserId(), name: name.trim(), normalized_name: normalizeSkill(name), category: 'other', source: 'manual', verified: true }, { onConflict: 'user_id,normalized_name' });
    if (error) return toast.error(error.message);
    setName('');
    qc.invalidateQueries({ queryKey: keys.skills });
  };
  return (
    <Panel title="Verified skills" description="Used for deterministic skill matching. Synced from your verified resume; add only skills you can demonstrate.">
      {isLoading ? <Skeleton className="h-16" /> : (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-1.5">
            {data.length === 0 && <span className="text-[13px] text-muted">No verified skills yet.</span>}
            {data.map((s) => (
              <Badge key={s.id} tone={s.source === 'manual' ? 'sky' : 'neutral'} className="pr-1">
                {s.name}
                <button aria-label={`Remove ${s.name}`} className="rounded-full p-0.5 hover:text-rose" onClick={async () => { await supabase.from('skills').delete().eq('id', s.id); qc.invalidateQueries({ queryKey: keys.skills }); }}>
                  <Trash2 />
                </button>
              </Badge>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input aria-label="Add skill" className="h-8 flex-1 rounded-[var(--radius-control)] border border-line-strong bg-surface px-2.5 text-[13px]" placeholder="Add a skill" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" disabled={!name.trim()}>Add</Button>
          </form>
        </div>
      )}
    </Panel>
  );
}

export default function ResumePage() {
  const resumes = useResumes();
  const profile = useProfile();
  const qc = useQueryClient();
  const [selected, setSelected] = React.useState<string | null>(null);
  const resume = resumes.data?.find((r) => r.id === selected) ?? resumes.data?.find((r) => r.is_primary) ?? resumes.data?.[0];
  const versions = useVersions(resume?.id);
  const [versionId, setVersionId] = React.useState<string | null>(null);
  const masterVersions = (versions.data ?? []).filter((v) => v.kind !== 'tailored');
  const version = masterVersions.find((v) => v.id === versionId) ?? masterVersions.find((v) => v.id === profile.data?.verified_resume_version_id) ?? masterVersions[0];
  const extract = useAction(() => post(`/resumes/${resume!.id}/extract`), { success: 'Extracted a new version', invalidate: [keys.resumes, ['versions']] });

  const refresh = (id: string) => {
    setSelected(id);
    setVersionId(null);
    qc.invalidateQueries({ queryKey: keys.resumes });
    qc.invalidateQueries({ queryKey: ['versions'] });
  };
  const openFile = async (r: Resume, download = false) => {
    const { data, error } = await supabase.storage.from('resumes').createSignedUrl(r.file_path, 120, download ? { download: r.file_name } : undefined);
    if (error || !data) return toast.error(error?.message ?? 'Could not open file');
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  const remove = async (r: Resume) => {
    await supabase.storage.from('resumes').remove([r.file_path]);
    const { error } = await supabase.from('resumes').delete().eq('id', r.id);
    if (error) return toast.error(error.message);
    toast('Resume deleted');
    setSelected(null);
    qc.invalidateQueries({ queryKey: keys.resumes });
    qc.invalidateQueries({ queryKey: keys.profile });
  };

  return (
    <>
      <PageHeader title="My resume" description="Upload, review the extracted details, and verify the version ApplyPilot is allowed to use. AI never adds qualifications you didn't confirm." />
      <ErrorNote error={resumes.error} retry={resumes.refetch} />
      {resumes.isLoading ? (
        <Skeleton className="h-48" />
      ) : !resumes.data?.length ? (
        <UploadZone onUploaded={refresh} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <div className="grid content-start gap-4">
            <Panel title="Files" bodyClassName="p-0">
              <ul>
                {resumes.data.map((r) => (
                  <li key={r.id} className={cn('border-b border-line px-3 py-2.5 last:border-0', r.id === resume?.id && 'bg-surface-2/70')}>
                    <button className="flex w-full items-start gap-2 text-left" onClick={() => { setSelected(r.id); setVersionId(null); }} aria-current={r.id === resume?.id}>
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium">{r.title}</span>
                        <span className="block text-[11px] text-muted">{humanize(r.status)} · {timeAgo(r.created_at)}</span>
                      </span>
                      {r.is_primary && <BadgeCheck className="ml-auto size-4 shrink-0 text-jade" aria-label="Primary resume" />}
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            <UploadZone onUploaded={refresh} />
            {resume && (
              <Panel title={resume.file_name} description={`${(resume.file_size / 1024).toFixed(0)} KB · uploaded ${formatDateTime(resume.created_at)}`}>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openFile(resume)}><Eye /> Preview</Button>
                  <Button size="sm" variant="ghost" onClick={() => openFile(resume, true)}><Download /> Download</Button>
                  <UploadZone compact replacing={resume} onUploaded={refresh} />
                  <ConfirmDialog
                    trigger={<Button size="sm" variant="ghost" className="text-rose"><Trash2 /> Delete</Button>}
                    title="Delete this resume?"
                    description="The file, its extracted text and every version (including tailored ones) are deleted permanently. Applications keep their own document copies."
                    confirmLabel="Delete resume"
                    danger
                    onConfirm={() => remove(resume)}
                  />
                </div>
                {resume.analysis_error && <p className="mt-2 text-xs text-rose">{resume.analysis_error}</p>}
                {masterVersions.length > 0 && (
                  <div className="mt-3 grid gap-1">
                    <p className="text-xs text-muted">Versions</p>
                    {masterVersions.map((v) => (
                      <button key={v.id} onClick={() => setVersionId(v.id)} className={cn('flex items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-surface-2', v.id === version?.id && 'bg-surface-2 font-semibold')}>
                        <span className="truncate">v{v.version_number} · {v.label || humanize(v.kind)}</span>
                        {v.id === profile.data?.verified_resume_version_id && <Badge tone="jade">Verified</Badge>}
                      </button>
                    ))}
                  </div>
                )}
              </Panel>
            )}
            <SkillsPanel />
          </div>
          <div className="grid content-start gap-4">
            {resume && !version && (
              <EmptyState icon={FileUp} title="No structured data yet" action={<Button variant="primary" loading={extract.isPending} onClick={() => extract.mutate(undefined)}><Sparkles /> Extract with Gemini</Button>}>
                {resume.status === 'failed' ? `Extraction failed: ${resume.analysis_error}` : 'Extract education, skills, experience, certifications and projects from the uploaded file.'}
              </EmptyState>
            )}
            {versions.isLoading && <Skeleton className="h-96" />}
            {version && <VersionEditor key={version.id} version={version} verifiedId={profile.data?.verified_resume_version_id ?? null} onSaved={setVersionId} />}
            {resume && version && <AnalysisPanel resume={resume} />}
          </div>
        </div>
      )}
    </>
  );
}
