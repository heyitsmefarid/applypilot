import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarPlus, Download, MapPin, Plus, Video } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorNote, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/overlay';
import { keys, useApplications, useInterviews } from '@/hooks/data';
import { useNow } from '@/hooks/now';
import { currentUserId, supabase } from '@/lib/supabase';
import type { Interview } from '@/lib/types';
import { formatDateTime, humanize, timeAgo } from '@/lib/utils';

function ics(i: Interview): string {
  const start = new Date(i.scheduled_at!);
  const end = new Date(start.getTime() + (i.duration_minutes ?? 60) * 60_000);
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ApplyPilot AI//EN',
    'BEGIN:VEVENT',
    `UID:${i.id}@applypilot`,
    `DTSTAMP:${f(new Date())}`,
    `DTSTART:${f(start)}`,
    `DTEND:${f(end)}`,
    `SUMMARY:${esc(`Interview: ${i.title}`)}`,
    `LOCATION:${esc(i.meeting_url || i.location)}`,
    `DESCRIPTION:${esc(i.notes || `${humanize(i.stage)} interview`)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Interview in 30 minutes',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function AddInterview() {
  const apps = useApplications();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ application_id: '', stage: 'screening', when: '', duration: '60', meeting_url: '', location: '', notes: '' });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const app = apps.data?.find((a) => a.id === form.application_id);
    const { error } = await supabase.from('interview_schedules').insert({
      user_id: await currentUserId(),
      application_id: form.application_id || null,
      title: app ? `${app.company} — ${app.job_title}` : 'Interview',
      stage: form.stage,
      scheduled_at: form.when ? new Date(form.when).toISOString() : null,
      duration_minutes: Number(form.duration) || null,
      meeting_url: form.meeting_url,
      location: form.location,
      notes: form.notes,
      status: form.when ? 'scheduled' : 'needs_confirmation',
      source: 'manual',
    });
    if (error) return toast.error(error.message);
    if (app && !['interview', 'offer'].includes(app.status)) await supabase.from('applications').update({ status: 'interview', status_source: 'user' }).eq('id', app.id);
    toast.success('Interview added');
    setOpen(false);
    qc.invalidateQueries({ queryKey: keys.interviews });
    qc.invalidateQueries({ queryKey: keys.applications });
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="primary"><Plus /> Add interview</Button></DialogTrigger>
      <DialogContent title="Add an interview">
        <form className="grid gap-3" onSubmit={save}>
          <Field label="Application">
            <NativeSelect value={form.application_id} onChange={(e) => setForm({ ...form, application_id: e.target.value })}>
              <option value="">Not linked</option>
              {(apps.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.company} — {a.job_title}</option>)}
            </NativeSelect>
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Stage">
              <NativeSelect value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
                {['screening', 'technical', 'hr', 'final', 'other'].map((s) => <option key={s} value={s}>{s === 'hr' ? 'HR' : humanize(s)}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Date & time"><Input type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} /></Field>
            <Field label="Minutes"><Input type="number" min={5} max={600} value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} /></Field>
          </div>
          <Field label="Meeting link"><Input type="url" value={form.meeting_url} onChange={(e) => setForm({ ...form, meeting_url: e.target.value })} placeholder="https://meet.google.com/…" /></Field>
          <Field label="Location"><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
          <Field label="Notes"><Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <DialogFooter><Button type="submit" variant="primary">Add interview</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({ i, onChange }: { i: Interview; onChange: () => void }) {
  const setStatus = async (status: Interview['status']) => {
    const { error } = await supabase.from('interview_schedules').update({ status }).eq('id', i.id);
    if (error) toast.error(error.message);
    onChange();
  };
  const now = useNow();
  const soon = i.scheduled_at && Date.parse(i.scheduled_at) - now < 24 * 3600_000 && Date.parse(i.scheduled_at) > now;
  return (
    <li className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-0">
      <div className="w-20 shrink-0 text-center">
        {i.scheduled_at ? (
          <>
            <p className="type-display figures text-[22px] leading-none">{new Date(i.scheduled_at).toLocaleDateString('en-PH', { day: 'numeric', timeZone: 'Asia/Manila' })}</p>
            <p className="text-xs text-muted">{new Date(i.scheduled_at).toLocaleDateString('en-PH', { month: 'short', weekday: 'short', timeZone: 'Asia/Manila' })}</p>
          </>
        ) : <Badge tone="amber">Time TBD</Badge>}
      </div>
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{i.title}</span>
          <Badge tone="outline">{i.stage === 'hr' ? 'HR' : humanize(i.stage)}</Badge>
          {soon && <Badge tone="amber">Within 24 h</Badge>}
          {i.source === 'email' && <Badge tone="sky">From email</Badge>}
        </div>
        <p className="text-xs text-muted">{i.scheduled_at ? `${formatDateTime(i.scheduled_at)} (${timeAgo(i.scheduled_at)})` : 'The email did not include a confirmed time.'}{i.duration_minutes ? ` · ${i.duration_minutes} min` : ''}</p>
        <div className="mt-1 flex flex-wrap gap-3 text-xs">
          {i.meeting_url && <a href={i.meeting_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-jade hover:underline"><Video className="size-3.5" /> Join link</a>}
          {i.location && <span className="inline-flex items-center gap-1 text-ink-2"><MapPin className="size-3.5" /> {i.location}</span>}
          {i.application_id && <Link to={`/applications/${i.application_id}`} className="text-jade hover:underline">Application</Link>}
          {i.message_id && <Link to={`/inbox?message=${i.message_id}`} className="text-jade hover:underline">Original email</Link>}
        </div>
        {i.notes && <p className="mt-1 text-xs text-ink-2">{i.notes}</p>}
      </div>
      <div className="flex items-center gap-2">
        {i.scheduled_at && (
          <Button size="sm" variant="ghost" onClick={() => {
            const url = URL.createObjectURL(new Blob([ics(i)], { type: 'text/calendar' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'interview.ics';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
          }}><Download /> .ics</Button>
        )}
        <NativeSelect aria-label="Interview status" className="h-7 w-40 text-xs" value={i.status} onChange={(e) => setStatus(e.target.value as Interview['status'])}>
          {['scheduled', 'needs_confirmation', 'rescheduled', 'completed', 'cancelled'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </NativeSelect>
      </div>
    </li>
  );
}

export default function Interviews() {
  const { data = [], isLoading, error, refetch } = useInterviews();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.interviews });
  const now = useNow();
  const toConfirm = data.filter((i) => i.status === 'needs_confirmation' || (!i.scheduled_at && i.status === 'scheduled'));
  const upcoming = data.filter((i) => i.scheduled_at && Date.parse(i.scheduled_at) >= now && ['scheduled', 'rescheduled'].includes(i.status));
  const past = data.filter((i) => !toConfirm.includes(i) && !upcoming.includes(i)).reverse();
  return (
    <>
      <PageHeader title="Interviews" description="Interviews detected in recruitment emails or added by you. Reminders are sent 24 hours ahead." actions={<AddInterview />} />
      <ErrorNote error={error} retry={refetch} />
      {isLoading ? <Skeleton className="h-48" /> : data.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No interviews yet">When an interview invitation reaches your Gmail, it appears here automatically. You can also add one manually.</EmptyState>
      ) : (
        <div className="grid gap-4">
          {toConfirm.length > 0 && <Panel title="Needs a confirmed time" bodyClassName="p-0"><ul>{toConfirm.map((i) => <Row key={i.id} i={i} onChange={refresh} />)}</ul></Panel>}
          <Panel title="Upcoming" bodyClassName="p-0">{upcoming.length ? <ul>{upcoming.map((i) => <Row key={i.id} i={i} onChange={refresh} />)}</ul> : <p className="flex items-center gap-2 px-4 py-6 text-[13px] text-muted"><CalendarPlus className="size-4" /> Nothing scheduled.</p>}</Panel>
          {past.length > 0 && <Panel title="Past & cancelled" bodyClassName="p-0"><ul>{past.map((i) => <Row key={i.id} i={i} onChange={refresh} />)}</ul></Panel>}
        </div>
      )}
    </>
  );
}
