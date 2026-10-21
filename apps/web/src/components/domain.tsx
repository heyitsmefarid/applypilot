import { APPLICATION_STATUS_LABELS, formatSalary, type ApplicationStatus } from '@applypilot/core';
import { Bookmark, BookmarkCheck, Building2, Clock, EyeOff, ExternalLink, MapPin, Wallet } from 'lucide-react';
import { Link } from 'react-router';
import { useNow } from '@/hooks/now';
import type { JobMatch, JobWithMatch } from '@/lib/types';
import { cn, humanize, timeAgo } from '@/lib/utils';
import { Badge } from './ui/display';
import { Tooltip } from './ui/overlay';

export function scoreTone(score: number | null | undefined, eligible?: boolean | null): 'jade' | 'amber' | 'rose' | 'neutral' {
  if (score === null || score === undefined) return 'neutral';
  if (eligible === false) return 'rose';
  if (score >= 75) return 'jade';
  if (score >= 55) return 'amber';
  return 'rose';
}

const ringColor = { jade: 'var(--jade)', amber: 'var(--amber)', rose: 'var(--rose)', neutral: 'var(--line-strong)' };

/** AI match indicator: a ring gauge with the score in condensed figures. */
export function ScoreRing({ match, size = 44 }: { match?: Pick<JobMatch, 'score' | 'eligible' | 'status'> | null; size?: number }) {
  const score = match?.score ?? null;
  const tone = scoreTone(score, match?.eligible);
  const r = size / 2 - 3.5;
  const circ = 2 * Math.PI * r;
  const label = score === null ? 'Not scored yet' : `${score}% match${match?.eligible === false ? ', not eligible' : ''}`;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label} title={label}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={4} />
        {score !== null && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringColor[tone]} strokeWidth={4} strokeLinecap="round" strokeDasharray={`${(score / 100) * circ} ${circ}`} />}
      </svg>
      <span className={cn('figures absolute inset-0 flex items-center justify-center font-semibold', size >= 56 ? 'text-lg' : 'text-[13px]', score === null && 'text-muted')}>{score ?? '—'}</span>
    </div>
  );
}

const STATUS_TONE: Record<ApplicationStatus, 'neutral' | 'jade' | 'amber' | 'rose' | 'sky' | 'outline'> = {
  discovered: 'outline',
  saved: 'neutral',
  draft_prepared: 'sky',
  awaiting_approval: 'amber',
  submission_in_progress: 'sky',
  applied: 'jade',
  assessment: 'sky',
  interview: 'jade',
  offer: 'jade',
  rejected: 'rose',
  withdrawn: 'neutral',
  closed: 'neutral',
  submission_failed: 'rose',
};

export function StatusBadge({ status }: { status: ApplicationStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{APPLICATION_STATUS_LABELS[status]}</Badge>;
}

const SOURCE_NAMES: Record<string, string> = {
  remotive: 'Remotive',
  arbeitnow: 'Arbeitnow',
  jobicy: 'Jobicy',
  himalayas: 'Himalayas',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  manual: 'Imported',
  demo: 'Demo',
};

export function sourceName(key: string) {
  if (key.startsWith('gmail_alert:')) return `${humanize(key.split(':')[1])} alert`;
  return SOURCE_NAMES[key] ?? humanize(key);
}

/** Required attribution: listings from public APIs credit the source and link to the original. */
export function SourceCredit({ job }: { job: Pick<JobWithMatch, 'source_key' | 'apply_url'> }) {
  return (
    <a href={job.apply_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-jade">
      via {sourceName(job.source_key)}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

export function JobMeta({ job, className }: { job: JobWithMatch; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted', className)}>
      <span className="inline-flex items-center gap-1">
        <Building2 className="size-3.5" aria-hidden />
        {job.company}
      </span>
      <span className="inline-flex items-center gap-1">
        <MapPin className="size-3.5" aria-hidden />
        {job.location || 'Location not stated'}
      </span>
      <span className="inline-flex items-center gap-1">
        <Wallet className="size-3.5" aria-hidden />
        {formatSalary(job)}
      </span>
      <span className="inline-flex items-center gap-1">
        <Clock className="size-3.5" aria-hidden />
        {job.posted_at ? `Posted ${timeAgo(job.posted_at)}` : `Found ${timeAgo(job.discovered_at)}`}
      </span>
    </div>
  );
}

export function JobRow({ job, onToggleSave, onHide, showScore = true }: { job: JobWithMatch; onToggleSave?: (job: JobWithMatch) => void; onHide?: (job: JobWithMatch) => void; showScore?: boolean }) {
  const match = job.job_matches?.[0];
  const saved = Boolean(job.saved_jobs?.length);
  const app = job.applications?.[0];
  const now = useNow();
  const fresh = job.posted_at && now - Date.parse(job.posted_at) < 3 * 86_400_000;
  return (
    <li className="group relative flex gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-2/50">
      {showScore && <ScoreRing match={match} />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/jobs/${job.id}`} className="truncate text-[14px] font-semibold text-ink after:absolute after:inset-0 hover:text-jade">
            {job.title}
          </Link>
          {fresh && <Badge tone="jade">New</Badge>}
          {job.status === 'expired' && <Badge tone="rose">Expired</Badge>}
          {app && <StatusBadge status={app.status} />}
        </div>
        <JobMeta job={job} className="mt-1" />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone="outline">{humanize(job.work_arrangement)}</Badge>
          <Badge tone="outline">{humanize(job.employment_type)}</Badge>
          {job.experience_level !== 'unknown' && job.experience_level !== job.employment_type && <Badge tone="outline">{humanize(job.experience_level)}</Badge>}
          {job.work_arrangement !== 'onsite' && job.ph_eligibility !== 'unknown' && <Badge tone={job.ph_eligibility === 'eligible' ? 'jade' : 'rose'}>{job.ph_eligibility === 'eligible' ? 'Accepts PH applicants' : 'Excludes PH'}</Badge>}
          {match?.eligibility?.warnings?.length ? <Badge tone="amber">{match.eligibility.warnings.length} to verify</Badge> : null}
        </div>
      </div>
      <div className="relative z-10 flex shrink-0 flex-col items-end justify-between gap-2">
        <SourceCredit job={job} />
        <div className="flex items-center gap-1">
          {onToggleSave && (
            <Tooltip content={saved ? 'Remove from saved' : 'Save job'}>
              <button className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-jade" onClick={() => onToggleSave(job)} aria-label={saved ? 'Remove from saved' : 'Save job'} aria-pressed={saved}>
                {saved ? <BookmarkCheck className="size-4 text-jade" /> : <Bookmark className="size-4" />}
              </button>
            </Tooltip>
          )}
          {onHide && (
            <Tooltip content={job.is_hidden ? 'Show job again' : 'Hide job'}>
              <button className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-ink" onClick={() => onHide(job)} aria-label={job.is_hidden ? 'Show job again' : 'Hide job'}>
                <EyeOff className="size-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </li>
  );
}

export function RunStatusDot({ status }: { status: string }) {
  const color: Record<string, string> = { queued: 'bg-muted', running: 'bg-sky animate-pulse', succeeded: 'bg-jade', partial: 'bg-amber', failed: 'bg-rose', cancelled: 'bg-line-strong' };
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', color[status] ?? 'bg-muted')} aria-hidden />;
}
