import { decodeEntities, stripHtml } from '../text.js';
import { finalizeJob } from './normalize.js';
import type { NormalizedJob } from '../schemas/job.js';

export type AlertPlatform = 'linkedin' | 'indeed' | 'jobstreet' | 'onlinejobs' | 'kalibrr' | 'other';

interface LinkPattern {
  platform: AlertPlatform;
  sender: RegExp;
  link: RegExp;
  id: (url: URL, match: RegExpMatchArray) => string | null;
  canonical: (id: string, url: URL) => string;
}

/**
 * Platforms that restrict automated access (LinkedIn, Indeed, JobStreet, OnlineJobs.ph)
 * are covered by parsing the job-alert emails they send you — no scraping of their sites.
 */
const PATTERNS: LinkPattern[] = [
  {
    platform: 'linkedin',
    sender: /linkedin\.com/i,
    link: /https?:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)[^\s"'<>]*/gi,
    id: (_u, m) => m[1] ?? null,
    canonical: (id) => `https://www.linkedin.com/jobs/view/${id}/`,
  },
  {
    platform: 'indeed',
    sender: /indeed\.com/i,
    link: /https?:\/\/(?:[a-z]{2,3}\.)?indeed\.com\/(?:rc\/clk|viewjob|pagead\/clk|m\/viewjob)[^\s"'<>]*/gi,
    id: (u) => u.searchParams.get('jk') ?? u.searchParams.get('vjk'),
    canonical: (id, u) => `https://${u.hostname}/viewjob?jk=${id}`,
  },
  {
    platform: 'jobstreet',
    sender: /jobstreet|seek\.com/i,
    link: /https?:\/\/(?:[a-z.]+\.)?jobstreet\.com(?:\.ph)?\/(?:[a-z-]+\/)?job\/(\d+)[^\s"'<>]*/gi,
    id: (_u, m) => m[1] ?? null,
    canonical: (id, u) => `https://${u.hostname}/job/${id}`,
  },
  {
    platform: 'onlinejobs',
    sender: /onlinejobs\.ph/i,
    link: /https?:\/\/(?:www\.)?onlinejobs\.ph\/jobseekers\/job\/([^\s"'<>?#]+)[^\s"'<>]*/gi,
    id: (_u, m) => m[1] ?? null,
    canonical: (id) => `https://www.onlinejobs.ph/jobseekers/job/${id}`,
  },
  {
    platform: 'kalibrr',
    sender: /kalibrr/i,
    link: /https?:\/\/(?:www\.)?kalibrr\.com\/c\/[^/\s"'<>]+\/jobs\/(\d+)[^\s"'<>]*/gi,
    id: (_u, m) => m[1] ?? null,
    canonical: (id, u) => `${u.origin}${u.pathname.split('/jobs/')[0]}/jobs/${id}`,
  },
];

export interface AlertEmail {
  messageId: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  receivedAt: string;
}

export function detectAlertPlatform(from: string): AlertPlatform | null {
  return PATTERNS.find((p) => p.sender.test(from))?.platform ?? null;
}

function anchorTexts(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]!);
    const text = stripHtml(m[2]!).replace(/\s+/g, ' ').trim();
    if (text && text.length > 3 && text.length < 160 && !/^(view|apply|see|more|unsubscribe)/i.test(text)) {
      if (!map.has(href)) map.set(href, text);
    }
  }
  return map;
}

/**
 * Pulls job links out of an alert email. Titles come from link text; company and location
 * from the text lines that follow (alert layouts are usually "Title / Company / Location").
 */
export function parseJobAlertEmail(email: AlertEmail): NormalizedJob[] {
  const platform = PATTERNS.find((p) => p.sender.test(email.from));
  if (!platform) return [];
  const body = `${email.html}\n${email.text}`;
  const anchors = anchorTexts(email.html);
  const textLines = (email.text || stripHtml(email.html)).split('\n').map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();
  const jobs: NormalizedJob[] = [];

  for (const m of body.matchAll(platform.link)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(m[0]));
    } catch {
      continue;
    }
    const id = platform.id(url, m);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const anchor = [...anchors.entries()].find(([href]) => href.includes(id))?.[1] ?? null;
    let title = anchor;
    let company: string | null = null;
    let location = '';
    const titles = new Set(anchors.values());
    const usable = (line: string | undefined) => (line && line.length < 100 && !titles.has(line) ? line : null);
    if (title) {
      const idx = textLines.findIndex((l) => l.includes(title!));
      if (idx >= 0) {
        company = usable(textLines[idx + 1]);
        // Company lines in alerts often look like "Acme Corp · Makati (On-site)".
        if (company?.includes('·')) {
          const [c, l] = company.split('·').map((s) => s.trim());
          company = c || company;
          location = l ?? '';
        } else if (company) {
          location = usable(textLines[idx + 2]) ?? '';
        }
      }
    }
    if (!title) title = email.subject.replace(/^(new )?jobs?( alert)?:?\s*/i, '').slice(0, 200) || 'Job from alert';
    const r = finalizeJob({
      source_key: `gmail_alert:${platform.platform}`,
      external_id: `${platform.platform}:${id}`,
      title,
      company: company ?? platform.platform.replace(/^\w/, (c) => c.toUpperCase()),
      location,
      description_text: `Imported from a ${platform.platform} job alert email ("${email.subject}"). Open the original posting for the full description.`,
      apply_url: platform.canonical(id, url),
      posted_at: email.receivedAt,
      tags: [platform.platform, 'job-alert'],
    });
    if ('job' in r) jobs.push(r.job);
  }
  return jobs;
}
