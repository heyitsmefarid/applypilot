import type { Session } from '@supabase/supabase-js';
import * as React from 'react';
import { post } from '@/lib/api';
import { supabase } from '@/lib/supabase';

interface AuthState {
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const bootstrapped = React.useRef(false);

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // First sign-in: create default search profiles + sources (idempotent on the Worker).
  React.useEffect(() => {
    if (!session || bootstrapped.current) return;
    bootstrapped.current = true;
    post('/bootstrap').catch(() => {
      bootstrapped.current = false;
    });
  }, [session]);

  const value = React.useMemo<AuthState>(
    () => ({
      session,
      loading,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message);
      },
      async signOut() {
        await supabase.auth.signOut();
      },
    }),
    [session, loading],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
