import { describe, expect, it } from 'vitest';
import { bundleCore } from './build.js';
import { validateWorkflows } from './validate.js';
import { ALL_WORKFLOWS } from './workflows.js';

describe('n8n workflows', async () => {
  const bundle = await bundleCore();
  const workflows = ALL_WORKFLOWS(bundle);

  it('pass structural validation', () => {
    expect(validateWorkflows(workflows)).toEqual([]);
  });

  it('ship inactive so they are reviewed before running', () => {
    expect(workflows.every((w) => w.active === false)).toBe(true);
  });

  it('runs the bundled core adapters inside a Code-node-like sandbox', async () => {
    const wf = workflows.find((w) => w.name.includes('Job Discovery'))!;
    const node = wf.nodes.find((n) => n.name === 'Normalize listings')!;
    const requests = [
      { json: { source_key: 'remotive', kind: 'remotive', url: 'https://remotive.com/api/remote-jobs', meta: {} } },
      { json: { source_key: 'greenhouse', kind: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', meta: { board: 'acme' } } },
    ];
    const responses = [
      { json: { jobs: [{ id: 1, url: 'https://remotive.com/remote-jobs/1', title: 'Junior React Developer', company_name: 'Acme', job_type: 'full_time', publication_date: '2026-10-19T10:00:00', candidate_required_location: 'Worldwide', description: '<p>React</p>' }] } },
      { json: { error: { message: 'getaddrinfo ENOTFOUND' } } },
    ];
    const $ = (name: string) => ({
      all: () => (name === 'Split requests' ? requests : []),
      first: () => ({ json: { run_id: 'run-1' } }),
    });
    // n8n's task-runner sandbox drops Object.defineProperty accessors; simulate that so getter-based
    // exports (esbuild's default) fail here exactly as they did in production.
    const hardenedObject = new Proxy(Object, { get: (t, k) => (k === 'defineProperty' ? (o: object) => o : Reflect.get(t, k)) });
    // It also has no global URL constructor.
    const fn = new Function('$input', '$', 'Object', 'URL', `return (async () => {\n${node.parameters.jsCode}\n})()`);
    const out = (await fn({ all: () => responses }, $, hardenedObject, undefined)) as Array<{ json: { source_key: string; jobs: unknown[]; fetch_errors: unknown[] } }>;
    const remotive = out.find((o) => o.json.source_key === 'remotive')!;
    const gh = out.find((o) => o.json.source_key === 'greenhouse')!;
    expect(remotive.json.jobs).toHaveLength(1);
    expect(gh.json.jobs).toHaveLength(0);
    expect(gh.json.fetch_errors).toEqual([{ url: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', error: 'getaddrinfo ENOTFOUND' }]);
  });

  it('keeps the run lifecycle when a batch is empty (no-op item)', async () => {
    const wf = workflows.find((w) => w.name.includes('AI Job Matching'))!;
    const split = wf.nodes.find((n) => n.name === 'Split jobs')!;
    const fn = new Function('$input', `return (async () => {\n${split.parameters.jsCode}\n})()`);
    expect(await fn({ first: () => ({ json: { jobs: [] } }) })).toEqual([{ json: { noop: true } }]);
  });
});
