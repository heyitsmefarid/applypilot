export interface Env {
  APP_URL: string;
  CORS_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  SUPABASE_JWT_SECRET?: string;
  ALLOWED_USER_EMAIL?: string;

  GEMINI_API_KEY?: string;
  GEMINI_MODEL_FAST: string;
  GEMINI_MODEL_QUALITY: string;
  GEMINI_API_STYLE: 'interactions' | 'generate_content';
  GEMINI_RPM: string;

  INTERNAL_API_TOKEN: string;
  RUNNER_API_TOKEN: string;
  TOKEN_ENCRYPTION_KEY: string;
  STATE_SIGNING_KEY: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;

  N8N_WEBHOOK_BASE_URL?: string;
  N8N_WEBHOOK_TOKEN?: string;

  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
  RUNNER_ALLOWED_HOSTS: string;
}

export type Actor = 'user' | 'n8n' | 'runner' | 'system';

export interface AppVariables {
  userId: string;
  userEmail: string;
  actor: Actor;
}

export type AppContext = { Bindings: Env; Variables: AppVariables };

/** Integration readiness flags (booleans only — never secret values). */
export function integrationStatus(env: Env) {
  return {
    supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY),
    gemini: Boolean(env.GEMINI_API_KEY),
    gmail_oauth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI),
    token_encryption: Boolean(env.TOKEN_ENCRYPTION_KEY && env.TOKEN_ENCRYPTION_KEY.length >= 40),
    n8n_push: Boolean(env.N8N_WEBHOOK_BASE_URL && env.N8N_WEBHOOK_TOKEN),
    github_runner: Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO),
    models: { fast: env.GEMINI_MODEL_FAST, quality: env.GEMINI_MODEL_QUALITY, api: env.GEMINI_API_STYLE },
  };
}
