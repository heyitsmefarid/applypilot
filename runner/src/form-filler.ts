import type { Locator, Page } from '@playwright/test';

/**
 * Label-driven form filling for allow-listed application pages. It only types what the user
 * approved (profile, approved documents, approved screening answers) and reports anything it
 * could not answer instead of guessing.
 */

export interface ApplicantData {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  portfolio: string;
  coverLetter: string;
  resumePath: string;
  screening: Array<{ question: string; answer: string; needs_user_input?: boolean }>;
  /** Only true for an approved submission: lets the runner tick a privacy/consent checkbox. */
  acceptConsent: boolean;
}

export interface FillReport {
  filled: Array<{ field: string; value_preview: string }>;
  unanswered: string[];
  missingRequired: string[];
}

const PATTERNS: Array<{ key: keyof ApplicantData; re: RegExp }> = [
  { key: 'firstName', re: /\b(first|given)\s*name\b/i },
  { key: 'lastName', re: /\b(last|family|sur)\s*name\b|\bsurname\b/i },
  { key: 'fullName', re: /\b(full\s*name|your name|^name$|applicant name)\b/i },
  { key: 'email', re: /e-?mail/i },
  { key: 'phone', re: /\b(phone|mobile|contact number|telephone)\b/i },
  { key: 'linkedin', re: /linkedin/i },
  { key: 'github', re: /github/i },
  { key: 'portfolio', re: /\b(portfolio|website|personal site|url)\b/i },
  { key: 'location', re: /\b(location|city|address|where are you based)\b/i },
  { key: 'coverLetter', re: /cover\s*letter|motivation letter/i },
];

const preview = (v: string) => (v.length > 60 ? `${v.slice(0, 57)}…` : v);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));

/** Best approved screening answer for a question (word overlap ≥ 50 %), else null. */
export function matchAnswer(question: string, answers: ApplicantData['screening']): string | null {
  const q = words(question);
  let best: { score: number; answer: string } | null = null;
  for (const a of answers) {
    if (a.needs_user_input) continue;
    const w = words(a.question);
    const overlap = [...q].filter((x) => w.has(x)).length / Math.max(1, Math.min(q.size, w.size));
    if (overlap >= 0.5 && (!best || overlap > best.score)) best = { score: overlap, answer: a.answer };
  }
  return best?.answer ?? null;
}

async function labelFor(page: Page, el: Locator): Promise<string> {
  return el.evaluate((node) => {
    const e = node as HTMLInputElement;
    const parts: string[] = [];
    if (e.labels?.length) parts.push(...Array.from(e.labels).map((l) => l.textContent ?? ''));
    const aria = e.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const labelledby = e.getAttribute('aria-labelledby');
    if (labelledby) parts.push(...labelledby.split(' ').map((id) => document.getElementById(id)?.textContent ?? ''));
    if (e.placeholder) parts.push(e.placeholder);
    if (!parts.length) parts.push(e.name || e.id || '');
    return parts.join(' ').replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  });
}

export async function fillForm(page: Page, data: ApplicantData): Promise<FillReport> {
  const report: FillReport = { filled: [], unanswered: [], missingRequired: [] };
  const form = page.locator('form').filter({ has: page.locator('input, textarea, select') }).first();
  const fields = form.locator('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');
  const count = await fields.count();
  for (let i = 0; i < count; i++) {
    const el = fields.nth(i);
    if (!(await el.isVisible()) || (await el.isDisabled())) continue;
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    const type = (await el.getAttribute('type'))?.toLowerCase() ?? (tag === 'textarea' ? 'textarea' : tag);
    const label = await labelFor(page, el);
    const required = (await el.getAttribute('required')) !== null || (await el.getAttribute('aria-required')) === 'true';

    if (type === 'file') {
      if (/resume|cv|curriculum/i.test(label) || required) {
        await el.setInputFiles(data.resumePath);
        report.filled.push({ field: label || 'Resume', value_preview: data.resumePath.split(/[\\/]/).pop() ?? 'resume.pdf' });
      }
      continue;
    }
    if (type === 'checkbox') {
      if (/privacy|consent|agree|terms|certify/i.test(label)) {
        if (data.acceptConsent) {
          await el.check();
          report.filled.push({ field: label, value_preview: 'checked (approved submission)' });
        } else if (required) report.missingRequired.push(label);
      }
      continue;
    }
    if (type === 'radio') continue;

    const pattern = PATTERNS.find((p) => p.re.test(label));
    let value: string | null = pattern ? String(data[pattern.key] ?? '') : null;
    if (pattern?.key === 'fullName' && /first|last/i.test(label)) value = null;
    if (!value) value = matchAnswer(label, data.screening);
    if (!value) {
      if (label && (required || tag === 'textarea' || tag === 'select')) report.unanswered.push(label);
      if (required) report.missingRequired.push(label);
      continue;
    }
    if (tag === 'select') {
      const options = await el.locator('option').allTextContents();
      const wanted = options.find((o) => o.trim().toLowerCase() === value!.trim().toLowerCase()) ?? options.find((o) => o.toLowerCase().startsWith(value!.trim().toLowerCase().slice(0, 3)));
      if (!wanted) {
        report.unanswered.push(label);
        if (required) report.missingRequired.push(label);
        continue;
      }
      await el.selectOption({ label: wanted });
      value = wanted;
    } else if (type === 'number') {
      const n = value.match(/\d+(\.\d+)?/)?.[0];
      if (!n) {
        report.unanswered.push(label);
        if (required) report.missingRequired.push(label);
        continue;
      }
      await el.fill(n);
      value = n;
    } else {
      await el.fill(value);
    }
    report.filled.push({ field: label, value_preview: preview(value) });
  }
  return report;
}

export async function submitForm(page: Page) {
  const form = page.locator('form').filter({ has: page.locator('input, textarea, select') }).first();
  const button = form.locator('button[type=submit], input[type=submit]').or(form.getByRole('button', { name: /submit|apply|send application/i })).first();
  await Promise.all([page.waitForLoadState('domcontentloaded'), button.click()]);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
}

const CONFIRM = /thank you for (applying|your application)|application (has been |was )?(received|submitted)|we('ve| have) received your application|successfully (applied|submitted)/i;
const REF = /(reference|confirmation|application|tracking)\s*(id|number|no\.?|#|code)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i;

export async function readConfirmation(page: Page): Promise<{ text: string | null; id: string | null }> {
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const m = body.match(CONFIRM);
  const ref = body.match(REF);
  return { text: m ? body.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 200).trim() : null, id: ref?.[3] ?? null };
}
