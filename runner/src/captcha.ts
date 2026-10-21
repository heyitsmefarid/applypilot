import type { Page } from '@playwright/test';

/**
 * Detects CAPTCHA / anti-bot challenges. When one is present the runner stops immediately and
 * hands the application to the manual queue — it never attempts to solve or bypass it.
 */
const FRAME_SOURCES = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|geetest|captcha/i;
const SELECTORS = ['.g-recaptcha', '.h-captcha', '.cf-turnstile', '[data-sitekey]', 'iframe[title*="captcha" i]', '#challenge-form', '#px-captcha'];
const TEXT = /verify (that )?you are (a )?human|i'm not a robot|unusual traffic|checking your browser|press (and|&) hold/i;

export async function detectCaptcha(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    if (FRAME_SOURCES.test(frame.url())) return `challenge frame (${new URL(frame.url()).hostname})`;
  }
  for (const sel of SELECTORS) {
    if ((await page.locator(sel).count()) > 0) return `challenge element ${sel}`;
  }
  const text = await page.locator('body').innerText().catch(() => '');
  const m = text.match(TEXT);
  return m ? `challenge text "${m[0]}"` : null;
}
