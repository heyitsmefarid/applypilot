import { createHash } from 'node:crypto';

/**
 * Minimal, typed builder for n8n workflow JSON. Workflows are defined in TypeScript (reviewable,
 * testable) and exported to `n8n/workflows/*.json` for `n8n import:workflow`.
 */

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  webhookId?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  notes?: string;
  notesInFlow?: boolean;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }>;
  settings: Record<string, unknown>;
  pinData: Record<string, never>;
  meta: Record<string, unknown>;
  versionId: string;
}

/** Deterministic UUID-shaped id so regenerated JSON diffs cleanly. */
export function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Credentials are referenced by fixed ids; `scripts/setup` imports them with the same ids. */
export const CREDENTIALS = {
  internalApi: { httpHeaderAuth: { id: 'apInternalApiKey', name: 'ApplyPilot Internal API' } },
  webhookAuth: { httpHeaderAuth: { id: 'apWebhookAuthKey', name: 'ApplyPilot Webhook Auth' } },
  telegram: { telegramApi: { id: 'apTelegramBotKey', name: 'ApplyPilot Telegram Bot' } },
} as const;

export const WORKFLOW_IDS = {
  dispatcher: 'apDispatcher0000',
  discovery: 'apJobDiscovery01',
  resume: 'apResumeAnalys02',
  matching: 'apJobMatching003',
  prep: 'apAppPrep0000004',
  submit: 'apSubmission0005',
  gmail: 'apGmailMonitor06',
  followUp: 'apFollowUp000007',
  reports: 'apReports0000008',
  recovery: 'apErrorRecover09',
} as const;

export const API = '{{ $env.APPLYPILOT_API_URL }}';

export class Flow {
  nodes: N8nNode[] = [];
  connections: N8nWorkflow['connections'] = {};
  private col = 0;

  constructor(private workflowId: string) {}

  add(node: Omit<N8nNode, 'id' | 'position'> & { position?: [number, number] }): string {
    if (this.nodes.some((n) => n.name === node.name)) throw new Error(`Duplicate node name "${node.name}" in ${this.workflowId}`);
    const position = node.position ?? [this.col * 240, 0];
    this.col++;
    this.nodes.push({ id: stableUuid(`${this.workflowId}:${node.name}`), position, ...node });
    return node.name;
  }

  connect(from: string, to: string, output = 0, input = 0) {
    for (const n of [from, to]) if (!this.nodes.some((x) => x.name === n)) throw new Error(`Unknown node "${n}" in ${this.workflowId}`);
    const c = (this.connections[from] ??= { main: [] });
    while (c.main.length <= output) c.main.push([]);
    c.main[output]!.push({ node: to, type: 'main', index: input });
    return to;
  }

  /** Connects nodes in sequence: chain(a, b, c) = a→b→c. */
  chain(...names: string[]) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i]!, names[i + 1]!);
    return names.at(-1)!;
  }

  /** Lays out a horizontal row starting at column `x`, row `y` (grid units). */
  place(names: string[], y: number, x = 0) {
    names.forEach((name, i) => {
      const n = this.nodes.find((node) => node.name === name)!;
      n.position = [(x + i) * 240, y * 200];
    });
  }

  build(name: string, opts: { errorWorkflow?: boolean; saveSuccess?: boolean; description?: string } = {}): N8nWorkflow {
    return {
      id: this.workflowId,
      name,
      active: false,
      nodes: this.nodes,
      connections: this.connections,
      settings: {
        executionOrder: 'v1',
        timezone: 'Asia/Manila',
        saveManualExecutions: true,
        saveDataErrorExecution: 'all',
        saveDataSuccessExecution: opts.saveSuccess === false ? 'none' : 'all',
        callerPolicy: 'workflowsFromSameOwner',
        ...(opts.errorWorkflow === false ? {} : { errorWorkflow: WORKFLOW_IDS.recovery }),
      },
      pinData: {},
      meta: { templateCredsSetupCompleted: true, applypilot: { description: opts.description ?? '' } },
      versionId: stableUuid(`${this.workflowId}:${name}:version`),
    };
  }
}

// ─── Node factories ─────────────────────────────────────────────────────────

export function schedule(name: string, rule: { minutes?: number; hours?: number; cron?: string }) {
  const interval = rule.cron
    ? { field: 'cronExpression', expression: rule.cron }
    : rule.hours
      ? { field: 'hours', hoursInterval: rule.hours }
      : { field: 'minutes', minutesInterval: rule.minutes ?? 60 };
  return { name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [interval] } } };
}

/** Header-authenticated webhook (X-ApplyPilot-Webhook-Token) that responds immediately. */
export function webhook(name: string, path: string) {
  return {
    name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    webhookId: stableUuid(`webhook:${path}`),
    parameters: { httpMethod: 'POST', path, authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
    credentials: { ...CREDENTIALS.webhookAuth },
  };
}

export function code(name: string, jsCode: string, extra: Partial<N8nNode> = {}) {
  return { name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', jsCode: jsCode.trim() }, ...extra };
}

interface ApiCallOptions {
  method?: 'GET' | 'POST';
  /** Path or full expression after the API base, e.g. "/internal/runs/start". May contain {{ }} expressions. */
  path: string;
  /** JS expression (without {{ }}) that evaluates to the JSON body. */
  body?: string;
  timeoutMs?: number;
  retry?: { tries: number; waitMs: number } | false;
  /** One request per item with a pause between them (rate limits). */
  batch?: { size: number; intervalMs: number };
  continueOnFail?: boolean;
  runIdExpr?: string;
  executeOnce?: boolean;
  notes?: string;
}

/** Authenticated call to the ApplyPilot Worker internal API. */
export function api(name: string, o: ApiCallOptions) {
  const parameters: Record<string, unknown> = {
    method: o.method ?? 'POST',
    url: `=${API}${o.path}`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    options: {
      timeout: o.timeoutMs ?? 120_000,
      ...(o.batch ? { batching: { batch: { batchSize: o.batch.size, batchInterval: o.batch.intervalMs } } } : {}),
    },
  };
  if (o.runIdExpr) {
    parameters.sendHeaders = true;
    parameters.headerParameters = { parameters: [{ name: 'X-ApplyPilot-Run-Id', value: `={{ ${o.runIdExpr} }}` }] };
  }
  if ((o.method ?? 'POST') === 'POST') {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = `={{ JSON.stringify(${o.body ?? '{}'}) }}`;
  }
  const node: Omit<N8nNode, 'id' | 'position'> = {
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    parameters,
    credentials: { ...CREDENTIALS.internalApi },
  };
  if (o.retry !== false) {
    node.retryOnFail = true;
    node.maxTries = o.retry?.tries ?? 3;
    node.waitBetweenTries = o.retry?.waitMs ?? 3000;
  }
  if (o.continueOnFail) node.onError = 'continueRegularOutput';
  if (o.executeOnce) node.executeOnce = true;
  if (o.notes) {
    node.notes = o.notes;
    node.notesInFlow = true;
  }
  return node;
}

// ─── Shared Code snippets ───────────────────────────────────────────────────

/** First step after any trigger: normalise webhook vs schedule input. */
export const RESOLVE_RUN = `
// Webhook calls carry { run_id, input } from the dispatcher (or push mode); schedules carry neither.
const first = $input.first().json;
const body = first.body ?? {};
return [{ json: {
  run_id: body.run_id ?? null,
  trigger: body.run_id ? 'webhook' : 'schedule',
  input: body.input ?? {},
  execution_id: String($execution.id),
} }];
`;

/** Stops the workflow when the run is paused/cancelled; otherwise passes the run context on. */
export const GATE = `
const r = $input.first().json;
if (!r.proceed) {
  // Paused, cancelled or already finished: the Worker recorded why. Returning no items ends this execution.
  return [];
}
return [{ json: { run_id: r.run.id, input: r.run.input ?? {}, rules: r.rules ?? {} } }];
`;

export const startRunBody = (workflow: string, extraInput = '$json.input') =>
  `{ workflow: '${workflow}', run_id: $json.run_id, trigger: $json.trigger, n8n_execution_id: $json.execution_id, input: ${extraInput} }`;

/** HTTP-node error items (continueRegularOutput) look like { error: ... }. */
export const ERR_HELPER = `
const errOf = (j) => {
  if (!j || j.error === undefined) return null;
  const e = j.error;
  if (typeof e === 'string') return e;
  return e.message || e.description || JSON.stringify(e).slice(0, 300);
};
`;
