import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, jobPreferenceSchema, SALARY_PERIODS, WORK_ARRANGEMENTS } from '@applypilot/core';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, PageHeader, Panel, Skeleton } from '@/components/ui/display';
import { Checkbox, Field, Input, Label, NativeSelect, SwitchRow, Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/ui/overlay';
import { keys, usePreferences, useProfile, useRules } from '@/hooks/data';
import { currentUserId, supabase } from '@/lib/supabase';
import type { JobPreferenceRow, Profile } from '@/lib/types';
import { humanize, joinList, splitList } from '@/lib/utils';
import { useAuth } from '@/providers/auth';
import { useTheme } from '@/providers/theme';

function ProfileForm({ profile }: { profile: Profile }) {
  const qc = useQueryClient();
  const [form, setForm] = React.useState(profile);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const { full_name, phone, location, headline, timezone, portfolio_url, linkedin_url, github_url } = form;
    const { error } = await supabase.from('profiles').update({ full_name, phone, location, headline, timezone, portfolio_url, linkedin_url, github_url }).eq('id', profile.id);
    if (error) return toast.error(error.message);
    toast.success('Profile saved');
    qc.invalidateQueries({ queryKey: keys.profile });
  };
  const f = (k: keyof Profile) => ({ value: (form[k] as string) ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <Panel title="Profile" description="Used in application forms and emails. Syncs from your verified resume.">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={save}>
        <Field label="Full name"><Input {...f('full_name')} /></Field>
        <Field label="Email" hint="Your sign-in email"><Input value={profile.email} disabled /></Field>
        <Field label="Phone"><Input {...f('phone')} /></Field>
        <Field label="Location"><Input {...f('location')} /></Field>
        <Field label="Headline"><Input {...f('headline')} /></Field>
        <Field label="Time zone"><Input {...f('timezone')} /></Field>
        <Field label="Portfolio URL"><Input type="url" {...f('portfolio_url')} /></Field>
        <Field label="GitHub URL"><Input type="url" {...f('github_url')} /></Field>
        <Field label="LinkedIn URL"><Input type="url" {...f('linkedin_url')} /></Field>
        <div className="flex items-end justify-end sm:col-span-2"><Button type="submit" variant="primary">Save profile</Button></div>
      </form>
    </Panel>
  );
}

function MultiCheck<T extends string>({ label, options, value, onChange, format = humanize }: { label: string; options: readonly T[]; value: T[]; onChange: (v: T[]) => void; format?: (t: T) => string }) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-[13px] font-medium text-ink-2">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.filter((o) => o !== 'unknown').map((o) => (
          <label key={o} className="flex items-center gap-1.5 text-[13px]">
            <Checkbox checked={value.includes(o)} onCheckedChange={(c) => onChange(c ? [...value, o] : value.filter((x) => x !== o))} />
            {format(o)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PreferenceEditor({ pref }: { pref: JobPreferenceRow }) {
  const qc = useQueryClient();
  const [p, setP] = React.useState(pref);
  const [dirty, setDirty] = React.useState(false);
  const set = (patch: Partial<JobPreferenceRow>) => {
    setP({ ...p, ...patch });
    setDirty(true);
  };
  const list = (k: 'roles' | 'keywords' | 'excluded_keywords' | 'locations' | 'excluded_companies') => ({
    defaultValue: joinList(p[k]),
    onBlur: (e: React.FocusEvent<HTMLTextAreaElement | HTMLInputElement>) => set({ [k]: splitList(e.target.value) } as Partial<JobPreferenceRow>),
  });
  const save = async () => {
    const parsed = jobPreferenceSchema.safeParse(p);
    if (!parsed.success) return toast.error(parsed.error.issues[0]?.message ?? 'Invalid settings');
    const { id: _id, ...rest } = parsed.data;
    const { error } = await supabase.from('job_preferences').update(rest).eq('id', pref.id);
    if (error) return toast.error(error.message);
    toast.success(`"${p.name}" saved. New rules apply to the next matching run.`);
    setDirty(false);
    qc.invalidateQueries({ queryKey: keys.preferences });
  };
  const remove = async () => {
    const { error } = await supabase.from('job_preferences').delete().eq('id', pref.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: keys.preferences });
  };
  return (
    <Panel
      title={<span className="flex items-center gap-2">{p.name} {!p.is_active && <Badge>Inactive</Badge>}</span>}
      actions={
        <>
          <label className="flex items-center gap-2 text-xs"><Checkbox checked={p.is_active} onCheckedChange={(v) => set({ is_active: Boolean(v) })} /> Active</label>
          <ConfirmDialog trigger={<Button size="sm" variant="ghost" className="text-rose"><Trash2 /> Delete</Button>} title={`Delete "${p.name}"?`} description="Jobs already scored against this profile keep their scores until re-matched." confirmLabel="Delete profile" danger onConfirm={remove} />
          <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>Save changes</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Profile name"><Input value={p.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Preferred locations" hint="Cities for onsite/hybrid roles, or regions for remote"><Input {...list('locations')} /></Field>
          <Field label="Target roles" hint="Comma-separated" className="md:col-span-2"><Textarea rows={2} {...list('roles')} /></Field>
          <Field label="Keywords"><Input {...list('keywords')} /></Field>
          <Field label="Excluded title keywords"><Input {...list('excluded_keywords')} /></Field>
          <Field label="Excluded companies" className="md:col-span-2"><Input {...list('excluded_companies')} /></Field>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <MultiCheck label="Work arrangement" options={WORK_ARRANGEMENTS} value={p.work_arrangements} onChange={(v) => set({ work_arrangements: v })} />
          <MultiCheck label="Employment type" options={EMPLOYMENT_TYPES} value={p.employment_types} onChange={(v) => set({ employment_types: v })} />
          <MultiCheck label="Experience level" options={EXPERIENCE_LEVELS} value={p.experience_levels} onChange={(v) => set({ experience_levels: v })} format={(t) => (t === 'entry' ? 'Entry level' : humanize(t))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Minimum salary" hint="Leave empty for no floor">
            <Input type="number" min={0} step="0.5" value={p.min_salary_amount ?? ''} onChange={(e) => set({ min_salary_amount: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Currency"><Input value={p.salary_currency ?? ''} onChange={(e) => set({ salary_currency: e.target.value.toUpperCase().slice(0, 3) || null })} /></Field>
            <Field label="Per">
              <NativeSelect value={p.salary_period ?? 'hour'} onChange={(e) => set({ salary_period: e.target.value as JobPreferenceRow['salary_period'] })}>
                {SALARY_PERIODS.map((s) => <option key={s} value={s}>{s}</option>)}
              </NativeSelect>
            </Field>
          </div>
          <Field label="PHP per USD" hint="For salary conversion"><Input type="number" min={1} value={p.php_per_usd} onChange={(e) => set({ php_per_usd: Number(e.target.value) })} /></Field>
          <Field label="Required OJT hours" hint="Internships only"><Input type="number" min={1} value={p.required_ojt_hours ?? ''} onChange={(e) => set({ required_ojt_hours: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
          <Field label="Prefer postings from the last (days)"><Input type="number" min={1} max={90} value={p.max_posting_age_days} onChange={(e) => set({ max_posting_age_days: Number(e.target.value) })} /></Field>
          <Field label="Minimum match score"><Input type="number" min={0} max={100} value={p.min_match_score} onChange={(e) => set({ min_match_score: Number(e.target.value) })} /></Field>
          <Field label="Search every (minutes)" hint="Minimum 60; n8n schedule"><Input type="number" min={60} max={10080} value={p.search_frequency_minutes} onChange={(e) => set({ search_frequency_minutes: Number(e.target.value) })} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-[13px]"><Checkbox checked={p.require_ph_eligible} onCheckedChange={(v) => set({ require_ph_eligible: Boolean(v) })} /><Label>Must accept Philippine applicants</Label></label>
        </div>
      </div>
    </Panel>
  );
}

export default function SettingsPage() {
  const profile = useProfile();
  const prefs = usePreferences();
  const rules = useRules();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const { signOut } = useAuth();
  const addProfile = async () => {
    const base = jobPreferenceSchema.parse({ name: 'New search profile', roles: ['Software Developer'], work_arrangements: ['remote'] });
    const { id: _id, ...row } = base;
    const { error } = await supabase.from('job_preferences').insert({ ...row, user_id: await currentUserId() });
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: keys.preferences });
  };
  const saveRule = async (patch: Record<string, boolean>) => {
    const { error } = await supabase.from('automation_rules').update(patch).eq('id', rules.data!.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: keys.rules });
  };
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4">
        {profile.data ? <ProfileForm key={profile.data.id} profile={profile.data} /> : <Skeleton className="h-48" />}
        <div className="flex items-end justify-between gap-2 pt-2">
          <div>
            <h2 className="type-display text-[19px]">Search profiles</h2>
            <p className="text-[13px] text-muted">Each job is matched against the profile it fits best. Mandatory rules here are enforced before any AI call.</p>
          </div>
          <Button onClick={addProfile}><Plus /> Add profile</Button>
        </div>
        {prefs.isLoading ? <Skeleton className="h-64" /> : prefs.data?.map((p) => <PreferenceEditor key={p.id} pref={p} />)}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Notifications" description="In-app notifications are always on.">
            {rules.data && (
              <div className="divide-y divide-line">
                <SwitchRow label="Telegram messages" description="Daily summaries and alerts through the n8n Telegram node (configure the bot credential in n8n)" checked={rules.data.telegram_notifications} onCheckedChange={(v) => saveRule({ telegram_notifications: v })} />
                <SwitchRow label="Email reports" description="Send summaries to your own Gmail address" checked={rules.data.email_notifications} onCheckedChange={(v) => saveRule({ email_notifications: v })} />
              </div>
            )}
          </Panel>
          <Panel title="Appearance & session">
            <div className="grid gap-4">
              <Field label="Theme">
                <NativeSelect value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
                  <option value="system">Match system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </NativeSelect>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button onClick={signOut}>Sign out</Button>
                <Button variant="ghost" onClick={async () => { await supabase.auth.signOut({ scope: 'global' }); toast('Signed out on every device'); }}>Sign out everywhere</Button>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
