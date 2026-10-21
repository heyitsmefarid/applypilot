import { APPLICATION_STATUS_LABELS, APPLICATION_STATUSES, type ApplicationStatus } from '@applypilot/core';
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Briefcase, Columns3, Hand, Rows3, Search } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { Input, NativeSelect } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/ui/overlay';
import { keys, useApplications } from '@/hooks/data';
import { post } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { Application } from '@/lib/types';
import { cn, errorMessage, formatDate, humanize, timeAgo } from '@/lib/utils';

/** Statuses only automation may set (dragging there is not allowed). */
const AUTOMATION_ONLY: ApplicationStatus[] = ['submission_in_progress'];

function Card({ app }: { app: Application }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: app.id, data: { app } });
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn('relative cursor-grab touch-none rounded-[var(--radius-control)] border border-line bg-surface p-2.5 text-[13px] active:cursor-grabbing', isDragging && 'z-10 shadow-[0_12px_28px_-12px_rgba(12,17,23,0.45)] ring-1 ring-jade')}
      {...listeners}
      {...attributes}
      aria-label={`${app.job_title} at ${app.company}, ${APPLICATION_STATUS_LABELS[app.status]}. Press space to move.`}
    >
      <Link to={`/applications/${app.id}`} className="block font-semibold leading-snug hover:text-jade" onPointerDown={(e) => e.stopPropagation()}>
        {app.job_title}
      </Link>
      <p className="truncate text-xs text-muted">{app.company}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {app.match_score !== null && <Badge tone={app.match_score >= 75 ? 'jade' : app.match_score >= 55 ? 'amber' : 'neutral'} className="figures">{app.match_score}%</Badge>}
        {app.needs_manual_action && <Badge tone="amber"><Hand /> Manual</Badge>}
        {app.status === 'submission_failed' && <Badge tone="rose"><AlertTriangle /> Failed</Badge>}
        <span className="ml-auto text-[11px] text-muted">{timeAgo(app.updated_at)}</span>
      </div>
    </div>
  );
}

function Column({ status, apps }: { status: ApplicationStatus; apps: Application[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: AUTOMATION_ONLY.includes(status) });
  return (
    <section ref={setNodeRef} aria-label={APPLICATION_STATUS_LABELS[status]} className={cn('flex w-64 shrink-0 flex-col rounded-[var(--radius-panel)] border border-line bg-surface-2/50', isOver && 'border-jade bg-jade-soft/40')}>
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[13px] font-semibold">{APPLICATION_STATUS_LABELS[status]}</h2>
        <span className="figures text-xs text-muted">{apps.length}</span>
      </header>
      <div className="grid min-h-24 content-start gap-2 px-2 pb-2">
        {apps.map((a) => <Card key={a.id} app={a} />)}
        {apps.length === 0 && <p className="px-1 py-3 text-center text-[11px] text-muted">{AUTOMATION_ONLY.includes(status) ? 'Set by automation' : 'Drop here'}</p>}
      </div>
    </section>
  );
}

export default function Applications() {
  const { data = [], isLoading, error, refetch } = useApplications();
  const qc = useQueryClient();
  const [view, setView] = React.useState<'board' | 'table'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('applypilot-apps-view') === 'table' ? 'table' : 'board'));
  const [q, setQ] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');
  const [manualOnly, setManualOnly] = React.useState(false);
  const [pendingApplied, setPendingApplied] = React.useState<Application | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  const filtered = data.filter((a) => {
    if (manualOnly && !a.needs_manual_action) return false;
    if (statusFilter && a.status !== statusFilter) return false;
    if (q && !`${a.company} ${a.job_title} ${a.notes}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const manualCount = data.filter((a) => a.needs_manual_action).length;

  const setStatus = async (app: Application, status: ApplicationStatus) => {
    const { error: e } = await supabase.from('applications').update({ status, status_source: 'user' }).eq('id', app.id);
    if (e) return toast.error(e.message);
    toast.success(`Moved to ${APPLICATION_STATUS_LABELS[status]}`);
    qc.invalidateQueries({ queryKey: keys.applications });
    qc.invalidateQueries({ queryKey: keys.stats });
  };
  const onDragEnd = (e: DragEndEvent) => {
    const app = e.active.data.current?.app as Application | undefined;
    const to = e.over?.id as ApplicationStatus | undefined;
    if (!app || !to || to === app.status) return;
    // "Applied" needs submission evidence or your explicit confirmation.
    if (to === 'applied' && !app.submitted_at) return setPendingApplied(app);
    setStatus(app, to);
  };
  const switchView = (v: 'board' | 'table') => {
    setView(v);
    try {
      localStorage.setItem('applypilot-apps-view', v);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <PageHeader
        title="Applications"
        description="Every job you're pursuing, from saved to offer. Drag cards between columns to update them."
        actions={
          <div className="flex rounded-[var(--radius-control)] border border-line-strong p-0.5" role="group" aria-label="View">
            <Button size="sm" variant={view === 'board' ? 'secondary' : 'ghost'} className={cn(view === 'board' && 'border-0 bg-surface-2')} onClick={() => switchView('board')} aria-pressed={view === 'board'}><Columns3 /> Board</Button>
            <Button size="sm" variant={view === 'table' ? 'secondary' : 'ghost'} className={cn(view === 'table' && 'border-0 bg-surface-2')} onClick={() => switchView('table')} aria-pressed={view === 'table'}><Rows3 /> Table</Button>
          </div>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted" aria-hidden />
          <Input className="pl-8" aria-label="Search applications" placeholder="Search company, role or notes" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <NativeSelect aria-label="Filter by status" className="w-48" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {APPLICATION_STATUSES.map((s) => <option key={s} value={s}>{APPLICATION_STATUS_LABELS[s]}</option>)}
        </NativeSelect>
        <Button variant={manualOnly ? 'caution' : 'ghost'} onClick={() => setManualOnly((m) => !m)} aria-pressed={manualOnly}>
          <Hand /> Manual-action queue ({manualCount})
        </Button>
      </div>
      <ErrorNote error={error} retry={refetch} />
      {isLoading ? (
        <div className="flex gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 w-64" />)}</div>
      ) : data.length === 0 ? (
        <EmptyState icon={Briefcase} title="No applications yet" action={<Button variant="primary" asChild><Link to="/recommended">Browse recommended jobs</Link></Button>}>
          Open a job and choose Prepare application to generate tailored documents, or Track without documents.
        </EmptyState>
      ) : view === 'board' ? (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
            {APPLICATION_STATUSES.filter((s) => !statusFilter || s === statusFilter).map((s) => (
              <Column key={s} status={s} apps={filtered.filter((a) => a.status === s)} />
            ))}
          </div>
        </DndContext>
      ) : (
        <Panel bodyClassName="p-0 overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                {['Role', 'Status', 'Match', 'Channel', 'Submitted', 'Next follow-up', 'Updated', ''].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                  <td className="px-4 py-2.5">
                    <Link to={`/applications/${a.id}`} className="font-semibold hover:text-jade">{a.job_title}</Link>
                    <p className="text-xs text-muted">{a.company}</p>
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={a.status} />{a.needs_manual_action && <Badge tone="amber" className="ml-1">Manual</Badge>}</td>
                  <td className="figures px-4 py-2.5">{a.match_score ?? '—'}</td>
                  <td className="px-4 py-2.5">{humanize(a.channel)}</td>
                  <td className="px-4 py-2.5">{formatDate(a.submitted_at)}</td>
                  <td className="px-4 py-2.5">{formatDate(a.next_follow_up_at)}</td>
                  <td className="px-4 py-2.5 text-muted">{timeAgo(a.updated_at)}</td>
                  <td className="px-4 py-2.5">
                    <NativeSelect aria-label={`Change status of ${a.job_title}`} className="h-7 w-40 text-xs" value={a.status} onChange={(e) => {
                      const to = e.target.value as ApplicationStatus;
                      if (to === 'applied' && !a.submitted_at) setPendingApplied(a);
                      else setStatus(a, to);
                    }}>
                      {APPLICATION_STATUSES.map((s) => <option key={s} value={s} disabled={AUTOMATION_ONLY.includes(s)}>{APPLICATION_STATUS_LABELS[s]}</option>)}
                    </NativeSelect>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted">No applications match these filters.</p>}
        </Panel>
      )}
      <ConfirmDialog
        open={Boolean(pendingApplied)}
        onOpenChange={(o) => !o && setPendingApplied(null)}
        title="Confirm you submitted this application"
        description={<>ApplyPilot only marks an application as applied with submission evidence or your confirmation. Confirm that you submitted <b>{pendingApplied?.job_title}</b> at {pendingApplied?.company} yourself.</>}
        confirmLabel="Confirm submission"
        onConfirm={async () => {
          if (!pendingApplied) return;
          try {
            await post(`/applications/${pendingApplied.id}/confirm-submitted`, {});
            toast.success('Marked as applied');
            qc.invalidateQueries({ queryKey: keys.applications });
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </>
  );
}
