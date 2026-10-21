import { z } from 'zod';

/**
 * JSON Schema keywords sent to Gemini. Everything else is stripped. minItems/maxItems are left out on
 * purpose: large nested array bounds make Gemini reject the schema ("invalid argument"), and Zod
 * enforces the same limits when the response is parsed.
 */
const ALLOWED_KEYS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'minimum',
  'maximum',
  'propertyOrdering',
]);

type Json = { [k: string]: unknown };

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const obj = node as Json;

  // Collapse `anyOf: [X, {type: "null"}]` (zod nullable) into `type: [X.type, "null"]`.
  if (Array.isArray(obj.anyOf)) {
    const variants = obj.anyOf as Json[];
    const nonNull = variants.filter((v) => v.type !== 'null');
    const hasNull = nonNull.length !== variants.length;
    if (nonNull.length === 1) {
      const inner = sanitize(nonNull[0]) as Json;
      if (hasNull && typeof inner.type === 'string') inner.type = [inner.type, 'null'];
      if (obj.description && !inner.description) inner.description = obj.description;
      return inner;
    }
  }

  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, sanitize(pv)]));
      out.propertyOrdering = Object.keys(v as Json);
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

/** Converts a Zod schema into the JSON Schema subset accepted by Gemini structured output. */
export function toGeminiSchema(schema: z.ZodType): Json {
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Json;
  return sanitize(json) as Json;
}
