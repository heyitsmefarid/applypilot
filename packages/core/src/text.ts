const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  bull: '•',
  middot: '·',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Converts HTML to readable plain text without a DOM (works in Workers, n8n and Node).
 * Block elements become line breaks and list items become "- " bullets.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  let s = html;
  // Some APIs (Greenhouse) return entity-encoded HTML.
  if (/&lt;\s*\/?\s*[a-z]/i.test(s) && !/<\s*[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/\r/g, '')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Lowercase, strip accents/punctuation, collapse spaces — for comparisons and fingerprints. */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim();
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** Case-insensitive unique list of strings, preserving first spelling. */
export function uniqStrings(items: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  let d: Date;
  if (typeof value === 'number') {
    // Accept unix seconds or milliseconds.
    d = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{9,13}$/.test(trimmed)) return toIsoDate(Number(trimmed));
    d = new Date(trimmed);
  } else if (value instanceof Date) {
    d = value;
  } else {
    return null;
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extracts bullet-ish requirement lines from a description section such as "Requirements". */
export function extractRequirements(description: string, max = 25): string[] {
  const lines = description.split('\n').map((l) => l.trim());
  const out: string[] = [];
  let inSection = false;
  const header = /^(requirements?|qualifications?|what (you|we).{0,20}(need|bring|looking)|must[- ]haves?|who you are|skills( required)?|you have|you will need|minimum qualifications|preferred qualifications|nice to have)\b/i;
  const otherHeader = /^(responsibilities|what you.{0,10}do|benefits|perks|about (us|the)|why join|our offer|compensation|how to apply)\b/i;
  for (const line of lines) {
    if (!line) continue;
    const plain = line.replace(/^[-*•·]\s*/, '').replace(/:$/, '');
    if (header.test(plain) && plain.length < 80) {
      inSection = true;
      continue;
    }
    if (otherHeader.test(plain) && plain.length < 80) {
      inSection = false;
      continue;
    }
    if (inSection && plain.length > 3 && plain.length < 600) out.push(plain);
    if (out.length >= max) break;
  }
  return out;
}

/** Constant-time string comparison (for tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
