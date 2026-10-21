import {
  buildGmailQuery,
  decideStatusFromEmail,
  EMAIL_CATEGORY_LABELS,
  heuristicClassify,
  isLikelyRecruitmentEmail,
  matchEmailToApplication,
  PROMPTS,
  stripHtml,
  type ApplicationStatus,
  type EmailCategory,
} from '@applypilot/core';
import { detectAlertPlatform, parseJobAlertEmail } from '@applypilot/core/sources';
import { AiBudgetError, runAi, type AiContext } from '../ai/run.js';
import type { Env } from '../env.js';
import { b64url, b64urlDecode, decryptSecret, encryptSecret, randomId, signToken, verifyToken } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { unwrap, type Db } from '../lib/supabase.js';
import { audit, getProfile } from './context.js';
import { ingestJobs } from './discovery.js';
import { notify } from './notifications.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  // gmail.compose = create drafts and send. Sending only ever happens after explicit approval.
  'https://www.googleapis.com/auth/gmail.compose',
];

function requireOAuthConfig(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new HttpError(503, 'gmail_not_configured', 'Google OAuth credentials are not configured on the Worker.');
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_REDIRECT_URI };
}

export async function gmailAuthUrl(env: Env, userId: string) {
  const { clientId, redirectUri } = requireOAuthConfig(env);
  const state = await signToken({ uid: userId, n: randomId(8) }, env.STATE_SIGNING_KEY, 600);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(env: Env, body: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new HttpError(res.status === 400 ? 400 : 502, String(json.error ?? 'oauth_error'), String(json.error_description ?? json.error ?? `HTTP ${res.status}`));
  return json as { access_token: string; expires_in: number; refresh_token?: string; scope: string };
}

/** OAuth redirect target. Verifies the signed state, stores encrypted tokens. */
export async function gmailCallback(env: Env, db: Db, code: string, state: string) {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig(env);
  const payload = await verifyToken<{ uid: string }>(state, env.STATE_SIGNING_KEY);
  if (!payload?.uid) throw new HttpError(400, 'invalid_state', 'OAuth state is invalid or expired. Start the connection again.');
  const tokens = await tokenRequest(env, { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!tokens.refresh_token) throw new HttpError(400, 'no_refresh_token', 'Google did not return a refresh token. Remove ApplyPilot from your Google account permissions and connect again.');
  const scopes = tokens.scope.split(' ');
  if (!scopes.includes('https://www.googleapis.com/auth/gmail.readonly')) throw new HttpError(400, 'insufficient_scope', 'Gmail read access was not granted.');
  const profileRes = await fetch(`${GMAIL}/profile`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const profile = (await profileRes.json()) as { emailAddress?: string; historyId?: string };
  const row = {
    user_id: payload.uid,
    email: profile.emailAddress ?? '',
    scopes,
    access_token_enc: await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY),
    refresh_token_enc: await encryptSecret(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY),
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    history_id: profile.historyId ?? null,
    status: 'connected',
    last_error: null,
  };
  unwrap(await db.from('gmail_connections').upsert(row, { onConflict: 'user_id' }).select('id'), 'save gmail connection');
  await audit(db, payload.uid, 'user', 'gmail_connected', 'gmail_connections', null, { email: row.email, scopes });
  return { email: row.email };
}

interface Connection {
  id: string;
  email: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  last_sync_at: string | null;
  status: string;
  scopes: string[];
}

async function getConnection(db: Db, userId: string): Promise<Connection> {
  const c = unwrap(await db.from('gmail_connections').select('*').eq('user_id', userId).maybeSingle(), 'load gmail connection');
  if (!c || c.status === 'revoked') throw new HttpError(409, 'gmail_not_connected', 'Gmail is not connected.');
  return c as Connection;
}

/** Returns a valid access token, refreshing (and persisting) it when it is about to expire. */
async function accessToken(env: Env, db: Db, userId: string, conn: Connection): Promise<string> {
  if (conn.access_token_enc && conn.token_expires_at && Date.parse(conn.token_expires_at) > Date.now() + 60_000) {
    return decryptSecret(conn.access_token_enc, env.TOKEN_ENCRYPTION_KEY);
  }
  if (!conn.refresh_token_enc) throw new HttpError(409, 'gmail_reauth_required', 'Reconnect Gmail.');
  const { clientId, clientSecret } = requireOAuthConfig(env);
  try {
    const t = await tokenRequest(env, {
      refresh_token: await decryptSecret(conn.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY),
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    await db
      .from('gmail_connections')
      .update({ access_token_enc: await encryptSecret(t.access_token, env.TOKEN_ENCRYPTION_KEY), token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), status: 'connected', last_error: null })
      .eq('id', conn.id);
    return t.access_token;
  } catch (e) {
    if (e instanceof HttpError && e.code === 'invalid_grant') {
      // Revoked, expired (7-day limit for OAuth apps in "Testing"), or password changed.
      await db.from('gmail_connections').update({ status: 'error', last_error: 'Authorization expired or revoked — reconnect Gmail.' }).eq('id', conn.id);
      await notify(db, userId, { type: 'system', severity: 'warning', title: 'Reconnect Gmail', body: 'Google rejected the stored authorization (revoked or expired). Reconnect in Integrations.', link: '/integrations', dedupe_key: `gmail_reauth:${new Date().toISOString().slice(0, 10)}` });
      throw new HttpError(409, 'gmail_reauth_required', 'Gmail authorization expired. Reconnect Gmail.');
    }
    throw e;
  }
}

async function gmailFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GMAIL}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 429 || res.status === 403) {
    const body = await res.text();
    if (res.status === 429 || /rateLimitExceeded|userRateLimitExceeded|quota/i.test(body)) throw new HttpError(429, 'gmail_rate_limited', 'Gmail API quota exceeded — will retry later.');
    throw new HttpError(403, 'gmail_forbidden', `Gmail permission error: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new HttpError(502, 'gmail_error', `Gmail API HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

const utf8 = new TextDecoder();
function decodePart(data?: string): string {
  if (!data) return '';
  try {
    return utf8.decode(b64urlDecode(data));
  } catch {
    return '';
  }
}

export function extractBodies(payload: GmailPart): { text: string; html: string } {
  let text = '';
  let html = '';
  const walk = (p: GmailPart) => {
    if (p.mimeType === 'text/plain' && !text) text = decodePart(p.body?.data);
    else if (p.mimeType === 'text/html' && !html) html = decodePart(p.body?.data);
    p.parts?.forEach(walk);
  };
  walk(payload);
  return { text, html };
}

function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { name: m[1]!.trim(), email: m[2]!.trim().toLowerCase() };
  return { name: '', email: from.trim().toLowerCase() };
}

/**
 * Workflow 6 steps 1–2: fetches a small batch of recruitment-related messages (Workers free plan
 * allows 50 subrequests per invocation, so batches stay ≤ 15) and imports job-alert emails as jobs.
 */
export async function syncGmail(env: Env, db: Db, userId: string, opts: { max?: number; pageToken?: string | null } = {}) {
  const conn = await getConnection(db, userId);
  const token = await accessToken(env, db, userId, conn);
  const max = Math.min(opts.max ?? 10, 15);
  const query = conn.last_sync_at
    ? `${buildGmailQuery(30).replace(/newer_than:\d+d/, `after:${Math.floor(Date.parse(conn.last_sync_at) / 1000) - 3600}`)}`
    : buildGmailQuery(3);
  const list = await gmailFetch<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>(
    token,
    `/messages?${new URLSearchParams({ q: query, maxResults: String(max), ...(opts.pageToken ? { pageToken: opts.pageToken } : {}) })}`,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  const { data: known } = ids.length ? await db.from('recruitment_messages').select('gmail_message_id').eq('user_id', userId).in('gmail_message_id', ids) : { data: [] };
  const knownSet = new Set((known ?? []).map((k: { gmail_message_id: string }) => k.gmail_message_id));
  const fresh = ids.filter((id) => !knownSet.has(id));

  const rows: Array<Record<string, unknown>> = [];
  const alertJobs: unknown[] = [];
  for (const id of fresh) {
    const msg = await gmailFetch<{ id: string; threadId: string; snippet: string; labelIds?: string[]; internalDate: string; payload: GmailPart }>(token, `/messages/${id}?format=full`);
    const header = (n: string) => msg.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';
    const from = parseFrom(header('from'));
    const { text, html } = extractBodies(msg.payload);
    const body = (text || stripHtml(html)).slice(0, 20_000);
    const receivedAt = new Date(Number(msg.internalDate)).toISOString();
    const platform = detectAlertPlatform(header('from'));
    let category: EmailCategory | null = null;
    if (platform) {
      const jobs = parseJobAlertEmail({ messageId: id, from: header('from'), subject: header('subject'), html, text, receivedAt });
      alertJobs.push(...jobs);
      if (jobs.length) category = 'job_alert';
    }
    rows.push({
      user_id: userId,
      gmail_message_id: id,
      thread_id: msg.threadId,
      from_email: from.email,
      from_name: from.name,
      to_email: header('to').slice(0, 300),
      subject: header('subject').slice(0, 500),
      snippet: msg.snippet?.slice(0, 500) ?? '',
      body_text: body,
      received_at: receivedAt,
      labels: msg.labelIds ?? [],
      category,
      confidence: category ? 0.95 : null,
      classified_by: category ? 'heuristic' : null,
      processed_status: category ? 'classified' : 'new',
    });
  }
  if (rows.length) unwrap(await db.from('recruitment_messages').upsert(rows, { onConflict: 'user_id,gmail_message_id', ignoreDuplicates: true }).select('id'), 'store messages');
  let alertStats = null;
  if (alertJobs.length) alertStats = (await ingestJobs(db, userId, { source_key: 'gmail_alert', jobs: alertJobs })).stats;
  await db.from('gmail_connections').update({ last_sync_at: new Date().toISOString(), status: 'connected', last_error: null }).eq('id', conn.id);
  return { fetched: fresh.length, skipped_known: ids.length - fresh.length, alert_jobs: alertJobs.length, alert_stats: alertStats, next_page_token: list.nextPageToken ?? null, has_more: Boolean(list.nextPageToken) };
}

export async function unclassifiedMessages(db: Db, userId: string, limit = 10) {
  const rows = unwrap(await db.from('recruitment_messages').select('id').eq('user_id', userId).eq('processed_status', 'new').order('received_at').limit(Math.min(limit, 25)), 'unclassified');
  return (rows ?? []).map((r: { id: string }) => r.id);
}

/**
 * Workflow 6 steps 3–10: classify → link to an application → status change only on clear
 * evidence → interview extraction → reply draft (never sent automatically) → notification.
 */
export async function classifyMessage(ai: AiContext, messageId: string) {
  const { db, userId } = ai;
  const msg = unwrap(await db.from('recruitment_messages').select('*').eq('id', messageId).eq('user_id', userId).maybeSingle(), 'load message');
  if (!msg) throw notFound('Message');
  const email = { from: `${msg.from_name} <${msg.from_email}>`, subject: msg.subject as string, body: msg.body_text as string };
  if (!isLikelyRecruitmentEmail(email)) {
    await db.from('recruitment_messages').update({ category: 'other', confidence: 0.6, classified_by: 'heuristic', processed_status: 'ignored' }).eq('id', messageId);
    return { category: 'other', ignored: true };
  }
  const apps = unwrap(
    await db.from('applications').select('id, company, job_title, company_domain, status').eq('user_id', userId).not('status', 'in', '(withdrawn,closed)').order('updated_at', { ascending: false }).limit(60),
    'load applications',
  ) as Array<{ id: string; company: string; job_title: string; company_domain: string | null; status: ApplicationStatus }>;
  const profile = await getProfile(db, userId);

  let category: EmailCategory;
  let confidence: number;
  let classification: Record<string, unknown> | null = null;
  let classifiedBy: 'ai' | 'heuristic' = 'ai';
  try {
    const out = await runAi(
      ai,
      PROMPTS.emailClassify,
      { from: email.from, subject: email.subject, receivedAt: msg.received_at as string, body: email.body, candidateName: profile.full_name, openApplications: apps.map((a) => `${a.company} — ${a.job_title}`) },
      { relatedId: messageId },
    );
    classification = out.data;
    category = out.data.is_recruitment_related ? out.data.category : 'other';
    confidence = out.data.confidence;
  } catch (e) {
    if (!(e instanceof AiBudgetError) && !(e instanceof HttpError && e.code === 'gemini_not_configured')) throw e;
    const h = heuristicClassify(email);
    category = h.category;
    confidence = h.confidence;
    classifiedBy = 'heuristic';
  }

  const linked = matchEmailToApplication({ ...email, aiCompany: (classification?.company as string) || undefined, aiTitle: (classification?.job_title as string) || undefined }, apps);
  const app = linked ? apps.find((a) => a.id === linked.applicationId) ?? null : null;
  const decision = decideStatusFromEmail(category, confidence, app?.status ?? null);
  const receivedAt = msg.received_at as string;

  if (app) {
    const patch: Record<string, unknown> = { last_employer_message_at: receivedAt };
    if (decision.update && decision.to) {
      patch.status = decision.to;
      patch.status_source = 'gmail';
      if (decision.to === 'applied') Object.assign(patch, { submitted_at: receivedAt, confirmed_by: 'email' });
    }
    if (category !== 'job_alert' && msg.from_email && !/no-?reply|noreply/i.test(msg.from_email as string)) patch.recruiter_email = msg.from_email;
    if (msg.from_name && patch.recruiter_email) patch.recruiter_name = msg.from_name;
    await db.from('applications').update(patch).eq('id', app.id);
    await db.from('application_events').insert({
      user_id: userId,
      application_id: app.id,
      type: 'email',
      actor: 'gmail',
      message: `${EMAIL_CATEGORY_LABELS[category]} email: "${String(msg.subject).slice(0, 140)}"${decision.update ? ` → ${decision.to}` : ''}`,
      metadata: { message_id: messageId, confidence, decision },
    });
  }

  const interview = classification?.interview as { datetime_iso: string | null; timezone: string; duration_minutes: number | null; location: string; meeting_url: string; stage: string } | null | undefined;
  if (category === 'interview' && app) {
    const scheduled = interview?.datetime_iso && !Number.isNaN(Date.parse(interview.datetime_iso)) ? new Date(interview.datetime_iso).toISOString() : null;
    await db.from('interview_schedules').insert({
      user_id: userId,
      application_id: app.id,
      message_id: messageId,
      title: `${app.company} — ${app.job_title}`,
      stage: interview?.stage ?? 'other',
      scheduled_at: scheduled,
      duration_minutes: interview?.duration_minutes ?? null,
      timezone: interview?.timezone || profile.timezone,
      location: interview?.location ?? '',
      meeting_url: (interview?.meeting_url ?? '').startsWith('https://') ? interview!.meeting_url : '',
      status: scheduled ? 'scheduled' : 'needs_confirmation',
      source: 'email',
    });
  }

  const important = ['interview', 'offer', 'assessment', 'rejection', 'recruiter_outreach'].includes(category);
  await db
    .from('recruitment_messages')
    .update({
      category,
      confidence: Math.round(confidence * 100) / 100,
      classification,
      classified_by: classifiedBy,
      application_id: app?.id ?? null,
      status_update: decision,
      processed_status: 'classified',
      suggested_reply: (classification?.suggested_reply as string) || null,
      is_important: important,
    })
    .eq('id', messageId);

  if (important) {
    await notify(db, userId, {
      type: category === 'interview' ? 'interview' : 'email',
      severity: category === 'offer' ? 'success' : category === 'rejection' ? 'warning' : 'info',
      title: `${EMAIL_CATEGORY_LABELS[category]}: ${app ? `${app.company}` : String(msg.from_name || msg.from_email)}`,
      body: (classification?.summary as string) || String(msg.subject),
      link: `/inbox?message=${messageId}`,
      dedupe_key: `email:${messageId}`,
    });
  }
  return { category, confidence, classified_by: classifiedBy, application_id: app?.id ?? null, status_changed: decision.update ? decision.to : null };
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(v)))}?=`;
}

function buildRaw(opts: { to: string; from: string; subject: string; body: string; inReplyTo?: string; references?: string }) {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.references ?? opts.inReplyTo}`);
  return b64url(new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n${opts.body.replace(/\r?\n/g, '\r\n')}`));
}

/** Sends an email the user explicitly approved in the dashboard (never called by automation). */
export async function sendApprovedEmail(env: Env, db: Db, userId: string, input: { to: string; subject: string; body: string; threadId?: string | null; inReplyToMessageId?: string | null }) {
  const conn = await getConnection(db, userId);
  if (!conn.scopes.includes('https://www.googleapis.com/auth/gmail.compose')) throw new HttpError(409, 'insufficient_scope', 'Reconnect Gmail and grant send permission.');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.to)) throw new HttpError(400, 'bad_request', 'Invalid recipient address');
  const token = await accessToken(env, db, userId, conn);
  let inReplyTo: string | undefined;
  if (input.inReplyToMessageId) {
    const m = await gmailFetch<{ payload: GmailPart }>(token, `/messages/${input.inReplyToMessageId}?format=metadata&metadataHeaders=Message-ID`);
    inReplyTo = m.payload.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value;
  }
  const raw = buildRaw({ to: input.to, from: conn.email, subject: input.subject, body: input.body, inReplyTo });
  const sent = await gmailFetch<{ id: string; threadId: string }>(token, '/messages/send', { method: 'POST', body: JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }) });
  await audit(db, userId, 'user', 'email_sent', 'gmail', null, { to: input.to, subject: input.subject, gmail_id: sent.id });
  return sent;
}

export async function disconnectGmail(env: Env, db: Db, userId: string) {
  const { data: conn } = await db.from('gmail_connections').select('*').eq('user_id', userId).maybeSingle();
  if (!conn) return { disconnected: true };
  try {
    if (conn.refresh_token_enc) {
      const token = await decryptSecret(conn.refresh_token_enc as string, env.TOKEN_ENCRYPTION_KEY);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    }
  } catch (e) {
    console.warn('[gmail] revoke failed', (e as Error).message);
  }
  await db.from('gmail_connections').delete().eq('user_id', userId);
  await audit(db, userId, 'user', 'gmail_disconnected', 'gmail_connections');
  return { disconnected: true };
}
