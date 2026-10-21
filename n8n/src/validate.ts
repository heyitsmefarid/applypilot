import { WORKFLOW_WEBHOOK_PATHS } from '@applypilot/core';
import { CREDENTIALS, WORKFLOW_IDS, type N8nWorkflow } from './lib.js';

const TRIGGERS = new Set(['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.webhook', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.manualTrigger']);
const KNOWN_TYPES: Record<string, number[]> = {
  'n8n-nodes-base.scheduleTrigger': [1.2],
  'n8n-nodes-base.webhook': [2],
  'n8n-nodes-base.errorTrigger': [1],
  'n8n-nodes-base.code': [2],
  'n8n-nodes-base.httpRequest': [4.2],
  'n8n-nodes-base.telegram': [1.2],
};
const CRED_IDS = new Set(Object.values(CREDENTIALS).flatMap((c) => Object.values(c).map((x) => x.id)));

/** Structural checks run in CI so a broken export never reaches n8n. Returns a list of problems. */
export function validateWorkflows(workflows: N8nWorkflow[]): string[] {
  const problems: string[] = [];
  const webhookPaths = new Map<string, string>();
  const ids = new Set<string>();
  for (const wf of workflows) {
    const p = (m: string) => problems.push(`[${wf.name}] ${m}`);
    if (!/^[A-Za-z0-9]{16}$/.test(wf.id)) p(`workflow id "${wf.id}" must be 16 alphanumeric characters`);
    if (ids.has(wf.id)) p(`duplicate workflow id ${wf.id}`);
    ids.add(wf.id);
    const names = new Set(wf.nodes.map((n) => n.name));
    if (names.size !== wf.nodes.length) p('duplicate node names');
    for (const n of wf.nodes) {
      const versions = KNOWN_TYPES[n.type];
      if (!versions) p(`unknown node type ${n.type}`);
      else if (!versions.includes(n.typeVersion)) p(`${n.name}: unexpected typeVersion ${n.typeVersion}`);
      for (const c of Object.values(n.credentials ?? {})) if (!CRED_IDS.has(c.id)) p(`${n.name}: unknown credential ${c.id}`);
      if (n.type === 'n8n-nodes-base.code') {
        const js = String(n.parameters.jsCode ?? '');
        try {
          // Code nodes run inside an async function with $input/$json/... in scope.
          new Function('$input', '$', '$json', '$execution', '$env', `return (async () => {\n${js}\n})`);
        } catch (e) {
          p(`${n.name}: JavaScript syntax error — ${(e as Error).message}`);
        }
        if (!/return\s/.test(js)) p(`${n.name}: Code node must return items`);
      }
      if (n.type === 'n8n-nodes-base.webhook') {
        const path = String(n.parameters.path);
        if (webhookPaths.has(path)) p(`webhook path ${path} also used by ${webhookPaths.get(path)}`);
        webhookPaths.set(path, wf.name);
        if (n.parameters.authentication !== 'headerAuth') p(`${n.name}: webhook must use header authentication`);
      }
      if (n.type === 'n8n-nodes-base.httpRequest' && String(n.parameters.url).includes('/internal/') && n.parameters.authentication !== 'genericCredentialType') {
        p(`${n.name}: internal API call without credentials`);
      }
    }
    for (const [from, c] of Object.entries(wf.connections)) {
      if (!names.has(from)) p(`connection from unknown node ${from}`);
      for (const out of c.main) for (const t of out) if (!names.has(t.node)) p(`connection to unknown node ${t.node}`);
    }
    // Every node must be reachable from a trigger.
    const reached = new Set(wf.nodes.filter((n) => TRIGGERS.has(n.type)).map((n) => n.name));
    let grew = true;
    while (grew) {
      grew = false;
      for (const [from, c] of Object.entries(wf.connections)) {
        if (!reached.has(from)) continue;
        for (const out of c.main) for (const t of out) if (!reached.has(t.node)) { reached.add(t.node); grew = true; }
      }
    }
    for (const n of wf.nodes) if (!reached.has(n.name)) p(`${n.name} is not reachable from any trigger`);
    if (wf.id !== WORKFLOW_IDS.recovery && wf.settings.errorWorkflow !== WORKFLOW_IDS.recovery) p('errorWorkflow must point to Error Recovery');
  }
  for (const [workflow, path] of Object.entries(WORKFLOW_WEBHOOK_PATHS)) {
    if (!webhookPaths.has(path)) problems.push(`No workflow listens on ${path} (${workflow})`);
  }
  return problems;
}
