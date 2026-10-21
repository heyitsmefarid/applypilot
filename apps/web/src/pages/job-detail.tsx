import { CRITERION_LABELS, CRITERION_WEIGHTS, SCORE_CRITERIA } from '@applypilot/core';
import { ArrowLeft, Bookmark, BookmarkCheck, CheckCircle2, CircleHelp, ExternalLink, EyeOff, FileSignature, Gauge, Wand2, XCircle } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { JobMeta, ScoreRing, SourceCredit, StatusBadge, scoreTone } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Badge, ErrorNote, Meter, Panel, Skeleton } from '@/components/ui/display';
import { keys, useAction, useJob } from '@/hooks/data';
import { useJobActions } from '@/hooks/job-actions';
import { ApiError, post } from '@/lib/api';
import type { EligibilityCheck } from '@/lib/types';
import { cn, humanize, timeAgo } from '@/lib/utils';

const RULE_LABELS: Record<string, string> = {
  excluded_company: 'Excluded companies',
  excluded_keyword: 'Excluded keywords',
  role: 'Target role',
  expired: 'Listing still open',
  work_arrangement: 'Work arrangement',
  location: 'Location',
  ph_eligibility: 'Philippine applicants',
  employment_type: 'Employment type',
  experience: 'Experience level',
  salary: 'Salary floor',
  ojt_hours: 'OJT hours',
  freshness: 'Posting freshness',
};

function CheckIcon({ c }: { c: EligibilityCheck }) {
  if (c.outcome === 'pass') return <CheckCircle2 className="size-4 shrink-0 text-jade" aria-label="Pass" />;
  if (c.outcome === 'fail') return <XCircle className={cn('size-4 shrink-0', c.mandatory ? 'text-rose' : 'text-amber')} aria-label={c.mandatory ? 'Fails a required rule' : 'Preference not met'} />;
  return <CircleHelp className="size-4 shrink-0 text-amber" aria-label="Unknown — verify" />;
}

export default function JobDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: job, isLoading, error, refetch } = useJob(id);
  const actions = useJobActions();
  const score = useAction(() => post<{ score: number; used_ai: boolean; ai_note: string | null }>(`/jobs/${id}/match`), {
    success: (r) => (r.used_ai ? `Scored ${r.score}% with Gemini` : `Scored ${r.score}% with rules only${r.ai_note ? ` (${r.ai_note})` : ''}`),
    invalidate: [keys.job(id), ['jobs']],
  });
  const prepare = useAction(() => post<{ application_id: string; errors: unknown[] }>('/applications/prepare', { job_id: id }), {
    success: (r) => (r.errors.length ? `Documents prepared with ${r.errors.length} failed step(s)` : 'Tailored resume, cover letter, email and screening answers are ready'),
    invalidate: [keys.applications, keys.job(id)],
    onSuccess: (r) => navigate(`/applications/${r.application_id}`),
  });
  const track = useAction(() => post<{ application_id: string }>(`/jobs/${id}/track`), { success: 'Added to your applications', invalidate: [keys.applications, keys.job(id)] });

  if (isLoading) return <div className="grid gap-4"><Skeleton className="h-28" /><Skeleton className="h-96" /></div>;
  if (error || !job) return <ErrorNote error={error ?? new Error('Job not found')} retry={refetch} />;
  const match = job.job_matches[0];
  const app = job.applications?.[0];
  const saved = Boolean(job.saved_jobs?.length);
  const needsResume = score.error instanceof ApiError && score.error.code === 'no_verified_resume';
  const checks = match?.eligibility?.checks ?? [];

  return (
    <div className="grid gap-4">
      <button onClick={() => navigate(-1)} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Back
      </button>
      <header className="flex flex-wrap items-start gap-4 rounded-[var(--radius-panel)] border border-line bg-surface p-5">
        <ScoreRing match={match} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-display text-[24px]">{job.title}</h1>
            {app && <StatusBadge status={app.status} />}
            {job.status !== 'active' && <Badge tone="rose">{humanize(job.status)}</Badge>}
          </div>
          <JobMeta job={job} className="mt-1.5" />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="outline">{humanize(job.work_arrangement)}</Badge>
            <Badge tone="outline">{humanize(job.employment_type)}</Badge>
            {job.experience_level !== 'unknown' && job.experience_level !== job.employment_type && <Badge tone="outline">{humanize(job.experience_level)}</Badge>}
            {job.candidate_locations && <Badge tone="outline">Candidates: {job.candidate_locations}</Badge>}
            <SourceCredit job={job} />
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-col sm:items-stretch">
          {app ? (
            <Button variant="primary" asChild>
              <Link to={`/applications/${app.id}`}>
                <FileSignature /> Open application
              </Link>
            </Button>
          ) : (
            <Button variant="primary" loading={prepare.isPending} onClick={() => prepare.mutate(undefined)}>
              <Wand2 /> Prepare application
            </Button>
          )}
          <Button asChild>
            <a href={job.apply_url} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> Original posting
            </a>
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => actions.toggleSave(job)} aria-pressed={saved}>
              {saved ? <BookmarkCheck className="text-jade" /> : <Bookmark />} {saved ? 'Saved' : 'Save'}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => actions.toggleHide(job)}>
              <EyeOff /> {job.is_hidden ? 'Unhide' : 'Hide'}
            </Button>
          </div>
          {!app && (
            <Button variant="ghost" size="sm" loading={track.isPending} onClick={() => track.mutate(undefined)}>
              Track without documents
            </Button>
          )}
        </div>
      </header>
      {prepare.isPending && <p className="rounded-[var(--radius-control)] bg-sky-soft px-3 py-2 text-[13px] text-sky">Gemini is tailoring your resume and writing the cover letter. This takes up to a minute on the free tier.</p>}
      {needsResume && (
        <p className="rounded-[var(--radius-control)] bg-amber-soft px-3 py-2 text-[13px] text-amber">
          Verify your resume first — matching only uses information you confirmed. <Link className="font-semibold underline" to="/resume">Go to My resume</Link>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
        <div className="grid content-start gap-4">
          <Panel
            title="Compatibility"
            description={match ? `${match.eligibility?.profile ?? 'Search profile'} · scored ${timeAgo(match.scored_at)} · ${match.model === 'deterministic' ? 'rules only' : match.model}` : 'Not scored yet'}
            actions={
              <Button size="sm" loading={score.isPending} onClick={() => score.mutate(undefined)}>
                <Gauge /> {match ? 'Re-score' : 'Score now'}
              </Button>
            }
          >
            {!match ? (
              <p className="text-[13px] text-muted">Score this job against your verified resume and search profiles. Mandatory rules run first; Gemini adds the qualitative review.</p>
            ) : (
              <div className="grid gap-4">
                <div className={cn('rounded-[var(--radius-control)] border px-3 py-2.5 text-[13px] leading-relaxed', match.eligible ? 'border-line bg-surface-2/60' : 'border-rose/30 bg-rose-soft text-rose')}>
                  <p className="font-semibold">
                    {match.eligible ? { apply: 'Recommended: apply', consider: 'Worth considering', skip: 'Probably skip' }[match.recommendation ?? 'consider'] : 'Not eligible'}
                  </p>
                  <p className="mt-0.5 text-ink-2">{match.explanation}</p>
                  {match.eligibility?.ai_note && <p className="mt-1 text-xs text-amber">AI review skipped: {match.eligibility.ai_note}</p>}
                </div>
                <dl className="grid gap-2.5">
                  {SCORE_CRITERIA.map((k) => {
                    const c = match.breakdown?.[k];
                    if (!c) return null;
                    return (
                      <div key={k} className="grid gap-1">
                        <div className="flex items-baseline justify-between gap-2 text-[13px]">
                          <dt className="font-medium">
                            {CRITERION_LABELS[k]} <span className="text-xs font-normal text-muted">· weight {CRITERION_WEIGHTS[k]}% · {c.source}</span>
                          </dt>
                          <dd className="figures font-semibold">{c.score}</dd>
                        </div>
                        <Meter value={c.score} label={`${CRITERION_LABELS[k]} score`} tone={scoreTone(c.score) === 'neutral' ? 'sky' : (scoreTone(c.score) as 'jade' | 'amber' | 'rose')} />
                        {c.note && <p className="text-xs text-muted">{c.note}</p>}
                      </div>
                    );
                  })}
                </dl>
              </div>
            )}
          </Panel>

          {match && (
            <Panel title="Skills">
              <div className="grid gap-3 text-[13px]">
                <div>
                  <p className="mb-1.5 text-xs text-muted">Matching skills from your verified resume</p>
                  <div className="flex flex-wrap gap-1.5">{match.matched_skills.length ? match.matched_skills.map((s) => <Badge key={s} tone="jade">{s}</Badge>) : <span className="text-muted">None detected</span>}</div>
                </div>
                <div>
                  <p className="mb-1.5 text-xs text-muted">Missing — the job asks for these and your resume doesn't show them</p>
                  <div className="flex flex-wrap gap-1.5">{match.missing_skills.length ? match.missing_skills.map((s) => <Badge key={s} tone="outline">{s}</Badge>) : <span className="text-muted">Nothing missing</span>}</div>
                </div>
                {match.missing_qualifications.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs text-muted">Missing qualifications</p>
                    <ul className="list-disc space-y-0.5 pl-5">{match.missing_qualifications.map((q) => <li key={q}>{q}</li>)}</ul>
                  </div>
                )}
                {match.suggestions.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs text-muted">Suggested resume improvements (using your real experience)</p>
                    <ul className="list-disc space-y-0.5 pl-5">{match.suggestions.map((q) => <li key={q}>{q}</li>)}</ul>
                    <Button variant="link" size="sm" asChild className="mt-1">
                      <Link to={`/studio?job=${job.id}`}>Tailor resume in the studio</Link>
                    </Button>
                  </div>
                )}
              </div>
            </Panel>
          )}

          {checks.length > 0 && (
            <Panel title="Eligibility checks" description="Mandatory rules are checked in code, never by AI. Unknown details are not assumed to meet your requirements.">
              <ul className="grid gap-2">
                {checks.map((c) => (
                  <li key={c.rule} className="flex gap-2 text-[13px]">
                    <CheckIcon c={c} />
                    <span>
                      <span className="font-medium">{RULE_LABELS[c.rule] ?? humanize(c.rule)}</span>
                      {!c.mandatory && <span className="text-xs text-muted"> (preference)</span>}
                      <span className="block text-ink-2">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <Panel title="Job description" description={`Discovered ${timeAgo(job.discovered_at)}${job.expires_at ? ` · closes ${timeAgo(job.expires_at)}` : ''}`}>
          <div className="max-w-[72ch] whitespace-pre-line text-[13.5px] leading-relaxed text-ink-2">{job.description || 'No description available. Open the original posting.'}</div>
          {job.tags.length > 0 && <div className="mt-4 flex flex-wrap gap-1.5">{job.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
        </Panel>
      </div>
    </div>
  );
}
