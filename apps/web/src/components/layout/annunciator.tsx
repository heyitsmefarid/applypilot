import { useQuery } from '@tanstack/react-query';
import { OctagonPause, Play } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router';
import { keys, useAction, useIntegrations, useRules } from '@/hooks/data';
import { useNow } from '@/hooks/now';
import { post } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { cn, timeAgo } from '@/lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog, Tooltip } from '../ui/overlay';

type Lamp = 'go' | 'caution' | 'fault' | 'off';

const lampStyle: Record<Lamp, string> = {
  go: 'border-jade/40 bg-jade-soft text-jade',
  caution: 'border-amber/40 bg-amber-soft text-amber',
  fault: 'border-rose/40 bg-rose-soft text-rose',
  off: 'border-line bg-surface-2 text-muted',
};

/** One annunciator lamp: a lit, labelled cell like a cockpit caution panel. */
function Indicator({ state, label, detail, to }: { state: Lamp; label: string; detail: string; to: string }) {
  return (
    <Tooltip content={detail}>
      <Link to={to} className={cn('flex h-7 items-center gap-1.5 rounded-[5px] border px-2 text-[12px] font-semibold', lampStyle[state])}>
        <span className={cn('size-1.5 rounded-full', state === 'off' ? 'bg-muted/60' : 'bg-current', state === 'fault' && 'animate-pulse')} aria-hidden />
        <span className="figures">{label}</span>
        <span className="sr-only">: {detail}</span>
      </Link>
    </Tooltip>
  );
}

function useAiToday() {
  return useQuery({
    queryKey: [...keys.aiUsage, 'today'],
    queryFn: async () => {
      const { count } = await supabase.from('ai_usage_logs').select('id', { count: 'exact', head: true }).neq('status', 'budget_exceeded').gte('created_at', new Date(Date.now() - 86_400_000).toISOString());
      return count ?? 0;
    },
    refetchInterval: 60_000,
  });
}

/**
 * The system status strip. Always visible, because automation acts on the user's behalf:
 * engine heartbeat, Gmail, AI budget, apply mode — and the emergency pause.
 */
export function Annunciator() {
  const rules = useRules();
  const integrations = useIntegrations();
  const ai = useAiToday();
  const now = useNow();
  const [confirmResume, setConfirmResume] = React.useState(false);
  const pause = useAction((paused: boolean) => post('/automation/pause', { paused, reason: paused ? 'Emergency pause from the status bar' : undefined }), {
    success: (r: unknown) => ((r as { paused: boolean }).paused ? 'Automation paused. Queued runs were cancelled.' : 'Automation resumed'),
    invalidate: [keys.rules, ['runs']],
  });

  const r = rules.data;
  const seen = r?.n8n_last_seen_at ? now - Date.parse(r.n8n_last_seen_at) : null;
  const engine: Lamp = seen === null ? 'off' : seen < 5 * 60_000 ? 'go' : seen < 3 * 3600_000 ? 'caution' : 'fault';
  const gmail = integrations.data?.gmail;
  const gmailLamp: Lamp = !gmail ? 'off' : gmail.status === 'connected' ? 'go' : 'fault';
  const budget = r?.ai_daily_request_budget ?? 200;
  const used = ai.data ?? 0;
  const aiLamp: Lamp = !integrations.data?.gemini ? 'off' : used >= budget ? 'fault' : used >= budget * 0.8 ? 'caution' : 'go';
  const modeLabel = { manual: 'Manual', approval: 'Approval', auto: 'Auto-apply' }[r?.mode ?? 'manual'];

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="hidden min-w-0 items-center gap-1.5 md:flex">
        <Indicator state={engine} label="n8n" to="/automation" detail={seen === null ? 'n8n has never connected. Start it with Docker Compose.' : `Automation engine last checked in ${timeAgo(r?.n8n_last_seen_at)}`} />
        <Indicator state={gmailLamp} label="Gmail" to="/integrations" detail={gmail ? `${gmail.email} — ${gmail.status}${gmail.last_sync_at ? `, synced ${timeAgo(gmail.last_sync_at)}` : ''}` : 'Gmail is not connected'} />
        <Indicator state={aiLamp} label={`AI ${used}/${budget}`} to="/analytics" detail={integrations.data?.gemini ? `${used} of ${budget} Gemini requests used in the last 24 hours` : 'Gemini API key is not configured on the Worker'} />
        <Indicator state={r?.mode === 'auto' ? 'caution' : 'off'} label={modeLabel} to="/automation" detail={`Application mode: ${modeLabel}`} />
      </div>
      {r?.paused ? (
        <>
          <Button variant="caution" size="sm" onClick={() => setConfirmResume(true)} aria-label="Automation paused. Resume automation">
            <Play /> Resume
          </Button>
          <ConfirmDialog
            open={confirmResume}
            onOpenChange={setConfirmResume}
            title="Resume automation?"
            description={`Scheduled workflows will start running again${r.mode === 'auto' ? ', and conditional auto-apply may submit applications that match your rules' : ''}.`}
            confirmLabel="Resume automation"
            onConfirm={() => pause.mutateAsync(false).then(() => undefined)}
          />
        </>
      ) : (
        <Tooltip content="Emergency stop: cancels queued runs and blocks every automated action">
          <Button variant="danger" size="sm" loading={pause.isPending} onClick={() => pause.mutate(true)}>
            <OctagonPause /> Pause
          </Button>
        </Tooltip>
      )}
    </div>
  );
}
