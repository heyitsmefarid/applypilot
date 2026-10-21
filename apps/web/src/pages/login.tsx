import * as React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { supabaseConfigured } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';
import { useAuth } from '@/providers/auth';

export default function LoginPage() {
  const { session, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (session) return <Navigate to={from} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-surface p-10 lg:flex">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="type-display text-xl">ApplyPilot</span>
        </div>
        <div className="max-w-md">
          <p className="type-display text-[44px] leading-[1.02]">Find the roles that fit. Apply with documents you approved.</p>
          <p className="mt-4 text-[14px] leading-relaxed text-ink-2">
            Jobs from authorized sources, scored against your verified resume, tailored without invented qualifications, and tracked through your inbox.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-6 border-t border-line pt-6 text-[13px]">
          <div>
            <dt className="text-muted">Discovery</dt>
            <dd className="font-medium">Official APIs and job alerts</dd>
          </div>
          <div>
            <dt className="text-muted">Matching</dt>
            <dd className="font-medium">Rules first, then Gemini</dd>
          </div>
          <div>
            <dt className="text-muted">Submission</dt>
            <dd className="font-medium">Only with your approval</dd>
          </div>
        </dl>
      </section>
      <section className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="grid w-full max-w-sm gap-4" noValidate>
          <div className="mb-2 flex items-center gap-2 lg:hidden">
            <img src="/favicon.svg" alt="" className="size-7" />
            <span className="type-display text-lg">ApplyPilot</span>
          </div>
          <div>
            <h1 className="type-display text-[26px]">Sign in</h1>
            <p className="mt-1 text-[13px] text-muted">This is a private, single-user workspace. Registration is disabled.</p>
          </div>
          {!supabaseConfigured && (
            <p role="alert" className="rounded-[var(--radius-control)] border border-amber/40 bg-amber-soft px-3 py-2 text-[13px] text-amber">
              Supabase is not configured. Copy <code>apps/web/.env.example</code> to <code>.env.local</code> and add your project URL and publishable key.
            </p>
          )}
          <Field label="Email">
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && (
            <p role="alert" className="text-[13px] text-rose">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || !password}>
            Sign in
          </Button>
        </form>
      </section>
    </div>
  );
}
