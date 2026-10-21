import { readFileSync } from 'node:fs';
import { PROMPTS, resumeDataSchema, toGeminiSchema } from '@applypilot/core';
import { GeminiClient, parseJsonLoose } from './src/ai/gemini.js';
const vars = readFileSync('.dev.vars', 'utf8');
const get = (k: string) => vars.match(new RegExp(`^${k}=(.*)$`, 'm'))![1]!.trim();
const r = await fetch(`${get('SUPABASE_URL')}/rest/v1/resume_versions?select=content&order=created_at.desc&limit=1`, { headers: { apikey: get('SUPABASE_SECRET_KEY'), Authorization: `Bearer ${get('SUPABASE_SECRET_KEY')}` } });
const resume = resumeDataSchema.parse(((await r.json()) as Array<{ content: unknown }>)[0]!.content);
const p = PROMPTS.resumeEnhance;
const client = new GeminiClient(get('GEMINI_API_KEY'), 'interactions');
for (const model of [process.argv[2] ?? 'gemini-3.8-flash']) {
  const t = Date.now();
  try {
    const out = await client.generate({ model, system: p.system, input: p.build({ resume }), schema: toGeminiSchema(p.schema), timeoutMs: 240_000 });
    const parsed = p.schema.safeParse(parseJsonLoose(out.text));
    console.log(model, `${((Date.now() - t) / 1000).toFixed(1)}s`, `out=${out.outputTokens} total=${out.totalTokens}`, parsed.success ? `valid, ${parsed.data.changes.length} changes` : `INVALID ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
  } catch (e) { console.log(model, `${((Date.now() - t) / 1000).toFixed(1)}s`, 'ERROR', (e as Error).message.slice(0, 200)); }
}
