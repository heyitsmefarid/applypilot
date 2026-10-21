import type { Db } from '../lib/supabase.js';
import { notify } from './notifications.js';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const manilaDate = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

async function count(q: PromiseLike<{ count: number | null }>) {
  return (await q).count ?? 0;
}

/** Workflow 8 — daily summary. Returns plain text (also sent to Telegram by n8n when enabled). */
export async function dailyReport(db: Db, userId: string) {
  const since = hoursAgo(24);
  const head = { count: 'exact' as const, head: true };
  const [discovered, highMatches, submitted, awaiting, failures, interviews] = await Promise.all([
    count(db.from('job_listings').select('id', head).eq('user_id', userId).gte('discovered_at', since)),
    db.from('job_matches').select('score, job_listings(title, company)').eq('user_id', userId).eq('eligible', true).gte('scored_at', since).gte('score', 75).order('score', { ascending: false }).limit(5),
    count(db.from('applications').select('id', head).eq('user_id', userId).gte('submitted_at', since)),
    count(db.from('applications').select('id', head).eq('user_id', userId).in('status', ['draft_prepared', 'awaiting_approval'])),
    count(db.from('automation_runs').select('id', head).eq('user_id', userId).eq('status', 'failed').gte('created_at', since)),
    db.from('interview_schedules').select('title, scheduled_at').eq('user_id', userId).eq('status', 'scheduled').gte('scheduled_at', new Date().toISOString()).lte('scheduled_at', new Date(Date.now() + 48 * 3600_000).toISOString()).order('scheduled_at'),
  ]);
  const top = (highMatches.data ?? []).map((m: { score: number; job_listings: { title: string; company: string } | { title: string; company: string }[] | null }) => {
    const j = Array.isArray(m.job_listings) ? m.job_listings[0] : m.job_listings;
    return `• ${m.score}% — ${j?.title ?? 'Job'} @ ${j?.company ?? ''}`;
  });
  const ivs = (interviews.data ?? []).map((i: { title: string; scheduled_at: string }) => `• ${i.title} — ${new Date(i.scheduled_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })}`);
  const lines = [
    `ApplyPilot daily summary (${manilaDate()})`,
    `New jobs discovered: ${discovered}`,
    `High matches (≥75%): ${top.length}`,
    ...top,
    `Applications submitted: ${submitted}`,
    `Waiting for your approval: ${awaiting}`,
    `Interviews in the next 48 h: ${ivs.length}`,
    ...ivs,
    failures ? `⚠ Automation failures: ${failures} (see Automation Center)` : 'Automation: no failures',
  ];
  const text = lines.join('\n');
  await notify(db, userId, { type: 'report', severity: failures ? 'warning' : 'info', title: `Daily summary: ${discovered} new jobs, ${top.length} high matches`, body: text, link: '/', dedupe_key: `daily:${manilaDate()}` });
  return { text, stats: { discovered, high_matches: top.length, submitted, awaiting, failures, interviews: ivs.length } };
}

export async function weeklyReport(db: Db, userId: string) {
  const since = hoursAgo(24 * 7);
  const head = { count: 'exact' as const, head: true };
  const [discovered, scored, submitted, responses, interviews, offers, rejections] = await Promise.all([
    count(db.from('job_listings').select('id', head).eq('user_id', userId).gte('discovered_at', since)),
    count(db.from('job_matches').select('id', head).eq('user_id', userId).gte('scored_at', since)),
    count(db.from('applications').select('id', head).eq('user_id', userId).gte('submitted_at', since)),
    count(db.from('recruitment_messages').select('id', head).eq('user_id', userId).gte('received_at', since).in('category', ['acknowledgment', 'assessment', 'interview', 'offer', 'rejection'])),
    count(db.from('interview_schedules').select('id', head).eq('user_id', userId).gte('created_at', since)),
    count(db.from('applications').select('id', head).eq('user_id', userId).eq('status', 'offer').gte('updated_at', since)),
    count(db.from('applications').select('id', head).eq('user_id', userId).eq('status', 'rejected').gte('updated_at', since)),
  ]);
  const rate = submitted ? Math.round((responses / submitted) * 100) : 0;
  const text = [
    `ApplyPilot weekly statistics (week ending ${manilaDate()})`,
    `Jobs discovered: ${discovered} · scored: ${scored}`,
    `Applications submitted: ${submitted}`,
    `Employer responses: ${responses} (${rate}% response rate)`,
    `Interviews scheduled: ${interviews} · offers: ${offers} · rejections: ${rejections}`,
  ].join('\n');
  await notify(db, userId, { type: 'report', title: `Weekly statistics: ${submitted} applications, ${responses} responses`, body: text, link: '/analytics', dedupe_key: `weekly:${manilaDate()}` });
  return { text, stats: { discovered, scored, submitted, responses, interviews, offers, rejections, response_rate: rate } };
}

/** Interviews starting in the next 24 h that have not been reminded yet. */
export async function interviewReminders(db: Db, userId: string) {
  const { data } = await db
    .from('interview_schedules')
    .select('id, title, scheduled_at, meeting_url, location, application_id')
    .eq('user_id', userId)
    .eq('status', 'scheduled')
    .is('reminded_at', null)
    .gte('scheduled_at', new Date().toISOString())
    .lte('scheduled_at', new Date(Date.now() + 24 * 3600_000).toISOString());
  const lines: string[] = [];
  for (const i of data ?? []) {
    const when = new Date(i.scheduled_at as string).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
    lines.push(`⏰ Interview: ${i.title} — ${when}${i.meeting_url ? ` (${i.meeting_url})` : i.location ? ` @ ${i.location}` : ''}`);
    await notify(db, userId, { type: 'interview', severity: 'warning', title: `Interview soon: ${i.title}`, body: when, link: '/interviews', dedupe_key: `reminder:${i.id}` });
    await db.from('interview_schedules').update({ reminded_at: new Date().toISOString() }).eq('id', i.id);
  }
  return { text: lines.join('\n'), reminded: lines.length };
}

export async function pendingApprovalsReport(db: Db, userId: string) {
  const { data } = await db.from('applications').select('id, company, job_title, status, needs_manual_action').eq('user_id', userId).or('status.in.(draft_prepared,awaiting_approval),needs_manual_action.eq.true').limit(20);
  const items = (data ?? []).map((a: { company: string; job_title: string; status: string; needs_manual_action: boolean }) => `• ${a.job_title} @ ${a.company} — ${a.needs_manual_action ? 'manual action' : a.status.replace('_', ' ')}`);
  if (items.length) {
    await notify(db, userId, { type: 'approval_needed', title: `${items.length} application(s) waiting for you`, body: items.join('\n'), link: '/applications', dedupe_key: `pending:${manilaDate()}` });
  }
  return { text: items.length ? `Waiting for your approval:\n${items.join('\n')}` : '', count: items.length };
}
