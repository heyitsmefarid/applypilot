/**
 * Entry point bundled (esbuild, IIFE) into the "Normalize listings" Code node, so n8n uses the
 * exact, unit-tested adapters from @applypilot/core instead of a hand-copied re-implementation.
 *
 * Exports are assigned onto `__applypilot`, a plain object the Code node declares before the bundle.
 * esbuild's normal export wrapper uses Object.defineProperty getters, which n8n's hardened task-runner
 * sandbox strips — the functions came out undefined there even though they worked in plain Node.
 */
import { normalizeResponse } from '@applypilot/core/sources';

declare const __applypilot: Record<string, unknown>;
__applypilot.normalizeResponse = normalizeResponse;
