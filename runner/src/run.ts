import { renderResumePdf } from '@applypilot/core/pdf';
import { chromium, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerApi, RunnerPayload, RunnerResult } from './api.js';

/** The subset of the API client a run needs (tests pass an in-memory implementation). */
export type RunnerApiLike = Pick<RunnerApi, 'payload' | 'heartbeat' | 'result' | 'uploadEvidence'>;
import { detectCaptcha } from './captcha.js';
import { fillForm, readConfirmation, submitForm, type ApplicantData } from './form-filler.js';

export interface RunOptions {
  headless?: boolean;
  log?: (msg: string) => void;
}

export function applicantFrom(p: RunnerPayload, resumePath: string): ApplicantData {
  const full = p.applicant.full_name || p.resume.basics.name;
  const [first = '', ...rest] = full.split(' ');
  return {
    firstName: first,
    lastName: rest.join(' '),
    fullName: full,
    email: p.applicant.email || p.resume.basics.email,
    phone: p.applicant.phone || p.resume.basics.phone,
    location: p.applicant.location || p.resume.basics.location,
    linkedin: p.applicant.linkedin_url,
    github: p.applicant.github_url,
    portfolio: p.applicant.portfolio_url || p.applicant.github_url,
    coverLetter: p.cover_letter,
    resumePath,
    screening: p.screening_answers,
    acceptConsent: p.action === 'submit',
  };
}

/**
 * Executes one approved application run end-to-end and always reports a result:
 * allow-list → open page → CAPTCHA check → fill → (prefill: stop) → submit → confirmation → evidence.
 */
export async function executeRun(api: RunnerApiLike, runId: string, opts: RunOptions = {}): Promise<RunnerResult> {
  const log = opts.log ?? ((m: string) => console.log(`[runner ${runId.slice(0, 8)}] ${m}`));
  const started = Date.now();
  const screenshots: string[] = [];
  const workDir = mkdtempSync(join(tmpdir(), 'applypilot-'));
  let page: Page | null = null;
  const finish = async (r: Omit<RunnerResult, 'screenshots' | 'duration_ms'>): Promise<RunnerResult> => {
    const result: RunnerResult = { ...r, screenshots, duration_ms: Date.now() - started };
    const ack = await api.result(runId, result);
    log(`${result.outcome} → ${ack.message}`);
    return result;
  };
  const snap = async (name: string) => {
    if (!page) return;
    try {
      const bytes = await page.screenshot({ fullPage: true, type: 'png' });
      screenshots.push(await api.uploadEvidence(runId, name, bytes));
    } catch (e) {
      log(`screenshot ${name} failed: ${(e as Error).message}`);
    }
  };

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const payload = await api.payload(runId);
    const url = new URL(payload.application.apply_url);
    log(`${payload.action} ${payload.application.job_title} @ ${payload.application.company} (${url.hostname})`);
    if (!payload.allowed_hosts.includes(url.hostname.toLowerCase())) {
      return await finish({ outcome: 'manual_required', fields_filled: [], unanswered_questions: [], captcha_detected: false, error: `Host ${url.hostname} is not on the runner allow-list` });
    }

    const resumePath = join(workDir, `${(payload.applicant.full_name || 'Resume').replace(/[^a-z0-9 ]/gi, '').trim() || 'Resume'} - Resume.pdf`);
    writeFileSync(resumePath, renderResumePdf(payload.resume));

    const context = await browser.newContext({ locale: 'en-PH', timezoneId: 'Asia/Manila', viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    const challenge = await detectCaptcha(page);
    if (challenge) {
      await snap('captcha.png');
      return await finish({ outcome: 'manual_required', captcha_detected: true, fields_filled: [], unanswered_questions: [], error: `CAPTCHA detected (${challenge}) — automation stopped, not bypassed`, final_url: page.url() });
    }

    const report = await fillForm(page, applicantFrom(payload, resumePath));
    log(`filled ${report.filled.length} field(s); unanswered ${report.unanswered.length}`);
    await snap('filled.png');

    const hb = await api.heartbeat(runId);
    if (hb.cancel_requested || hb.paused) {
      return await finish({ outcome: 'manual_required', fields_filled: report.filled, unanswered_questions: report.unanswered, captcha_detected: false, error: 'Run cancelled or automation paused before submission' });
    }
    if (payload.action === 'prefill') {
      return await finish({ outcome: 'prefilled', fields_filled: report.filled, unanswered_questions: report.unanswered, captcha_detected: false, final_url: page.url() });
    }
    if (report.missingRequired.length) {
      return await finish({ outcome: 'manual_required', fields_filled: report.filled, unanswered_questions: report.unanswered, captcha_detected: false, error: `Required fields without an approved answer: ${report.missingRequired.join('; ')}` });
    }

    await submitForm(page);
    const after = await detectCaptcha(page);
    if (after) {
      await snap('captcha-after-submit.png');
      return await finish({ outcome: 'manual_required', captcha_detected: true, fields_filled: report.filled, unanswered_questions: report.unanswered, error: `CAPTCHA appeared on submit (${after})`, final_url: page.url() });
    }
    const confirmation = await readConfirmation(page);
    await snap('confirmation.png');
    return await finish({
      outcome: 'submitted',
      confirmation_text: confirmation.text,
      confirmation_id: confirmation.id,
      final_url: page.url(),
      fields_filled: report.filled,
      unanswered_questions: report.unanswered,
      captcha_detected: false,
    });
  } catch (e) {
    await snap('error.png');
    return await finish({ outcome: 'failed', fields_filled: [], unanswered_questions: [], captcha_detected: false, error: (e as Error).message.slice(0, 1500), final_url: page?.url() ?? null }).catch((err) => {
      log(`could not report failure: ${(err as Error).message}`);
      throw e;
    });
  } finally {
    await browser.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}
