const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiRequest {
  model: string;
  system: string;
  input: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GeminiResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    public status: number,
    public kind: 'rate_limited' | 'timeout' | 'server' | 'client' | 'blocked' | 'empty',
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === 'server' || this.kind === 'timeout' || (this.kind === 'rate_limited' && (this.retryAfterSeconds ?? 0) <= 20);
  }
}

type FetchLike = typeof fetch;

function parseRetryDelay(body: unknown): number | null {
  const details = (body as { error?: { details?: Array<Record<string, unknown>> } })?.error?.details ?? [];
  for (const d of details) {
    const delay = d.retryDelay;
    if (typeof delay === 'string') {
      const m = delay.match(/^(\d+(?:\.\d+)?)s$/);
      if (m) return Math.ceil(parseFloat(m[1]!));
    }
  }
  return null;
}

/** Extracts output text from an Interactions API response (steps → model_output → text parts). */
export function interactionText(body: Record<string, unknown>): string {
  if (typeof body.output_text === 'string' && body.output_text) return body.output_text;
  const steps = Array.isArray(body.steps) ? (body.steps as Array<Record<string, unknown>>) : [];
  const parts: string[] = [];
  for (const step of steps) {
    if (step.type !== 'model_output') continue;
    const content = Array.isArray(step.content) ? (step.content as Array<Record<string, unknown>>) : [];
    for (const c of content) if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  if (!parts.length && Array.isArray(body.outputs)) {
    for (const o of body.outputs as Array<Record<string, unknown>>) if (typeof o.text === 'string') parts.push(o.text);
  }
  return parts.join('');
}

export function generateContentText(body: Record<string, unknown>): string {
  const candidates = Array.isArray(body.candidates) ? (body.candidates as Array<Record<string, unknown>>) : [];
  const first = candidates[0];
  const parts = ((first?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined) ?? [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join('');
}

export class GeminiClient {
  constructor(
    private apiKey: string,
    private style: 'interactions' | 'generate_content' = 'interactions',
    // Wrapped: Workers throw "Illegal invocation" when fetch is called as a method of another object.
    private fetcher: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async post(url: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new GeminiError('Gemini request timed out', 0, 'timeout');
      throw new GeminiError(`Gemini network error: ${(e as Error).message}`, 0, 'server');
    }
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (res.ok) return body;
    const message = ((body.error as Record<string, unknown> | undefined)?.message as string | undefined) ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      throw new GeminiError(`Gemini rate limit / quota: ${message}`, 429, 'rate_limited', parseRetryDelay(body) ?? (header > 0 ? header : null));
    }
    if (res.status >= 500) throw new GeminiError(`Gemini server error: ${message}`, res.status, 'server');
    throw new GeminiError(`Gemini request rejected: ${message}`, res.status, 'client');
  }

  async generate(req: GeminiRequest): Promise<GeminiResult> {
    const timeoutMs = req.timeoutMs ?? 60_000;
    const maxOutputTokens = req.maxOutputTokens ?? 8192;
    if (this.style === 'interactions') {
      const body = await this.post(
        `${BASE}/interactions`,
        {
          model: req.model,
          system_instruction: req.system,
          input: req.input,
          response_format: { type: 'text', mime_type: 'application/json', schema: req.schema },
          generation_config: { max_output_tokens: maxOutputTokens, thinking_level: 'low' },
          store: false,
        },
        timeoutMs,
      );
      if (body.status && body.status !== 'completed') {
        throw new GeminiError(`Interaction ended with status "${String(body.status)}"`, 200, body.status === 'failed' ? 'server' : 'blocked');
      }
      const text = interactionText(body);
      if (!text) throw new GeminiError('Gemini returned no text', 200, 'empty');
      const usage = (body.usage as Record<string, number> | undefined) ?? {};
      return {
        text,
        inputTokens: usage.total_input_tokens ?? null,
        outputTokens: usage.total_output_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
      };
    }
    const body = await this.post(
      `${BASE}/models/${encodeURIComponent(req.model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.input }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: req.schema, maxOutputTokens },
      },
      timeoutMs,
    );
    const finish = ((body.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.finishReason as string | undefined) ?? '';
    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'].includes(finish)) throw new GeminiError(`Gemini blocked output (${finish})`, 200, 'blocked');
    const text = generateContentText(body);
    if (!text) throw new GeminiError('Gemini returned no text', 200, 'empty');
    const usage = (body.usageMetadata as Record<string, number> | undefined) ?? {};
    return {
      text,
      inputTokens: usage.promptTokenCount ?? null,
      outputTokens: usage.candidatesTokenCount ?? null,
      totalTokens: usage.totalTokenCount ?? null,
    };
  }

  /** Validates that a model id exists and the key can access it (used by the Integrations page). */
  async checkModel(model: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.fetcher(`${BASE}/models/${encodeURIComponent(model)}`, {
        headers: { 'x-goog-api-key': this.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { displayName?: string; inputTokenLimit?: number };
        return { ok: true, detail: `${body.displayName ?? model} (input limit ${body.inputTokenLimit ?? '?'} tokens)` };
      }
      return { ok: false, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

/** Gemini sometimes wraps JSON in ```json fences or adds prose; extract the first JSON object. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Response is not valid JSON');
  }
}
