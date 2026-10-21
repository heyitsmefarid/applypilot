/** AES-256-GCM + HMAC-SHA256 helpers built on WebCrypto (available in Workers). */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const b64url = (bytes: Uint8Array) => b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64urlDecode = (s: string) => b64decode(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secretB64: string): Promise<CryptoKey> {
  let k = keyCache.get(`aes:${secretB64}`);
  if (!k) {
    const raw = b64decode(secretB64);
    if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)');
    k = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(`aes:${secretB64}`, k);
  }
  return k;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(`hmac:${secret}`);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(`hmac:${secret}`, k);
  }
  return k;
}

/** Returns "v1.<iv>.<ciphertext>" (base64). The version prefix allows future key rotation. */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(plaintext)));
  return `v1.${b64encode(iv)}.${b64encode(ct)}`;
}

export async function decryptSecret(payload: string, keyB64: string): Promise<string> {
  const [version, ivB64, ctB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('Unsupported ciphertext format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(ivB64) }, await aesKey(keyB64), b64decode(ctB64));
  return dec.decode(pt);
}

export async function hmacSign(data: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return b64url(new Uint8Array(sig));
}

export async function hmacVerify(data: string, signature: string, secret: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(signature), enc.encode(data));
  } catch {
    return false;
  }
}

/** Compact signed token: base64url(json).signature — used for the OAuth state parameter. */
export async function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${await hmacSign(body, secret)}`;
}

export async function verifyToken<T extends Record<string, unknown>>(token: string, secret: string): Promise<T | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig || !(await hmacVerify(body, sig, secret))) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(body))) as T & { exp?: number };
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
