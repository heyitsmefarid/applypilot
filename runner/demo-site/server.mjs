#!/usr/bin/env node
/**
 * Demo application site for testing ApplyPilot end-to-end safely (no real employer involved).
 *
 *   node runner/demo-site/server.mjs            → http://localhost:4321
 *   /jobs/frontend-intern                        → job page with application form
 *   /jobs/frontend-intern?captcha=1              → same form behind a fake CAPTCHA (runner must stop)
 *   GET /api/submissions                         → JSON list of received applications
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'submissions');
mkdirSync(dataDir, { recursive: true });
const PORT = Number(process.env.DEMO_PORT ?? 4321);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Demo Co. Careers</title>
<style>
  body{font:15px/1.55 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}
  header{background:#22314a;color:#fff;padding:14px 24px;font-weight:600}
  main{max-width:720px;margin:24px auto;background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:24px}
  label{display:block;font-weight:600;margin:14px 0 4px}
  input,textarea,select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #c5ccd6;border-radius:6px;font:inherit}
  input[type=checkbox]{width:auto;margin-right:8px}
  .check{display:flex;align-items:center;font-weight:400}
  button{margin-top:20px;background:#22314a;color:#fff;border:0;border-radius:6px;padding:10px 18px;font:inherit;cursor:pointer}
  .note{background:#fff7e0;border:1px solid #f0d99a;padding:8px 12px;border-radius:6px;font-size:13px}
  .error{color:#b3261e}
</style></head><body><header>ApplyPilot Demo Co. — Careers (test site)</header><main>${body}</main></body></html>`;

const JOB = {
  slug: 'frontend-intern',
  title: 'Frontend Developer Intern (Demo)',
  location: 'Makati City, Metro Manila — onsite',
  description: 'Build React components with TypeScript. Interns render up to 600 OJT hours. This page exists only to test automation safely.',
};

function jobPage(url) {
  const captcha = url.searchParams.get('captcha') === '1';
  return page(JOB.title, `
  <p class="note">This is a local demo form. Nothing is sent to a real employer.</p>
  <h1>${esc(JOB.title)}</h1>
  <p><strong>${esc(JOB.location)}</strong></p>
  <p>${esc(JOB.description)}</p>
  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: JOB.title, hiringOrganization: { '@type': 'Organization', name: 'ApplyPilot Demo Co.' }, jobLocation: { '@type': 'Place', address: { addressLocality: 'Makati', addressCountry: 'PH' } }, employmentType: 'INTERN', datePosted: new Date().toISOString().slice(0, 10), description: JOB.description })}</script>
  <h2>Apply</h2>
  ${captcha ? '<div class="g-recaptcha" data-sitekey="demo-site-key">Please verify you are human.</div>' : ''}
  <form method="post" action="/apply/${JOB.slug}${captcha ? '?captcha=1' : ''}" enctype="multipart/form-data">
    <label for="first">First name *</label><input id="first" name="first_name" required>
    <label for="last">Last name *</label><input id="last" name="last_name" required>
    <label for="email">Email address *</label><input id="email" name="email" type="email" required>
    <label for="phone">Mobile number *</label><input id="phone" name="phone" required>
    <label for="city">City / Location</label><input id="city" name="location">
    <label for="li">LinkedIn URL</label><input id="li" name="linkedin" type="url">
    <label for="gh">GitHub URL</label><input id="gh" name="github" type="url">
    <label for="cv">Resume (PDF) *</label><input id="cv" name="resume" type="file" accept="application/pdf" required>
    <label for="cl">Cover letter</label><textarea id="cl" name="cover_letter" rows="6"></textarea>
    <label for="onsite">Are you willing to work onsite in Makati? *</label>
    <select id="onsite" name="onsite" required><option value="">Select…</option><option>Yes</option><option>No</option></select>
    <label for="hours">How many OJT hours are you required to render? *</label><input id="hours" name="ojt_hours" type="number" min="100" max="2000" required>
    <label for="why">Why do you want to join us?</label><textarea id="why" name="why" rows="4"></textarea>
    <label class="check"><input type="checkbox" name="consent" required>I agree to the privacy policy for processing my application *</label>
    <button type="submit">Submit application</button>
  </form>`);
}

async function handleApply(req, url, res) {
  const request = new Request(`http://localhost${url.pathname}`, { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
  const form = await request.formData();
  const get = (k) => (typeof form.get(k) === 'string' ? form.get(k).trim() : '');
  if (url.searchParams.get('captcha') === '1') {
    res.writeHead(403, { 'content-type': 'text/html' });
    return res.end(page('Blocked', '<p class="error">CAPTCHA not completed.</p>'));
  }
  const resume = form.get('resume');
  const missing = ['first_name', 'last_name', 'email', 'phone', 'onsite', 'ojt_hours', 'consent'].filter((k) => !get(k));
  if (!resume || typeof resume === 'string' || !resume.size) missing.push('resume');
  if (missing.length) {
    res.writeHead(422, { 'content-type': 'text/html' });
    return res.end(page('Missing information', `<p class="error">Please complete: ${missing.map(esc).join(', ')}</p><p><a href="/jobs/${JOB.slug}">Back</a></p>`));
  }
  const ref = `DEMO-${randomBytes(3).toString('hex').toUpperCase()}`;
  const record = {
    reference: ref,
    received_at: new Date().toISOString(),
    job: JOB.slug,
    applicant: { first_name: get('first_name'), last_name: get('last_name'), email: get('email'), phone: get('phone'), location: get('location'), linkedin: get('linkedin'), github: get('github') },
    answers: { onsite: get('onsite'), ojt_hours: get('ojt_hours'), why: get('why').slice(0, 2000) },
    cover_letter_chars: get('cover_letter').length,
    resume: { name: resume.name, size: resume.size, type: resume.type },
  };
  writeFileSync(join(dataDir, `${ref}.json`), JSON.stringify(record, null, 2));
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page('Application received', `<h1>Thank you for applying, ${esc(record.applicant.first_name)}!</h1>
    <p>Your application for <strong>${esc(JOB.title)}</strong> has been received.</p>
    <p>Reference number: <strong id="reference">${ref}</strong></p>`));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(page('Open roles', `<h1>Open roles</h1><ul><li><a href="/jobs/${JOB.slug}">${esc(JOB.title)}</a></li></ul>`));
    }
    if (req.method === 'GET' && url.pathname === `/jobs/${JOB.slug}`) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(jobPage(url));
    }
    if (req.method === 'POST' && url.pathname === `/apply/${JOB.slug}`) return await handleApply(req, url, res);
    if (req.method === 'GET' && url.pathname === '/api/submissions') {
      const list = readdirSync(dataDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(list));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Error: ${e.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Demo application site on http://localhost:${PORT}/jobs/${JOB.slug}`));
