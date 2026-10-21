import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { check, supabase } from '@/lib/supabase';
import type {
  AiUsageLog,
  AppNotification,
  Application,
  ApplicationDocument,
  ApplicationEvent,
  AutomationRules,
  AutomationRun,
  DashboardStats,
  IntegrationStatus,
  Interview,
  JobPreferenceRow,
  JobSource,
  JobWithMatch,
  Profile,
  RecruitmentMessage,
  Resume,
  ResumeVersion,
  Skill,
} from '@/lib/types';
import { errorMessage } from '@/lib/utils';

export const keys = {
  stats: ['stats'] as const,
  profile: ['profile'] as const,
  rules: ['rules'] as const,
  jobs: (f: unknown) => ['jobs', f] as const,
  job: (id: string) => ['job', id] as const,
  applications: ['applications'] as const,
  application: (id: string) => ['application', id] as const,
  resumes: ['resumes'] as const,
  versions: (resumeId?: string) => ['versions', resumeId ?? 'all'] as const,
  skills: ['skills'] as const,
  preferences: ['preferences'] as const,
  sources: ['sources'] as const,
  messages: (f: unknown) => ['messages', f] as const,
  interviews: ['interviews'] as const,
  runs: (f: unknown) => ['runs', f] as const,
  notifications: ['notifications'] as const,
  aiUsage: ['ai-usage'] as const,
  integrations: ['integrations'] as const,
};

const JOB_SELECT = '*, job_matches(*), saved_jobs(id), applications(id, status)';

export function useStats() {
  return useQuery({ queryKey: keys.stats, queryFn: async () => check(await supabase.rpc('dashboard_stats'), 'dashboard stats') as DashboardStats });
}

export function useProfile() {
  return useQuery({ queryKey: keys.profile, queryFn: async () => check(await supabase.from('profiles').select('*').single(), 'profile') as Profile });
}

export function useRules() {
  return useQuery({ queryKey: keys.rules, queryFn: async () => check(await supabase.from('automation_rules').select('*').single(), 'automation rules') as AutomationRules });
}

export interface JobFilters {
  view: 'all' | 'recommended' | 'saved' | 'hidden';
  q?: string;
  arrangement?: string;
  employment?: string;
  level?: string;
  source?: string;
  maxAgeDays?: number;
  minScore?: number;
  company?: string;
  location?: string;
  salaryOnly?: boolean;
  includeExpired?: boolean;
  limit?: number;
}

export function useJobs(f: JobFilters) {
  return useQuery({
    queryKey: keys.jobs(f),
    queryFn: async () => {
      // !inner turns the embedded filter into a filter on the jobs themselves.
      const inner = f.view === 'recommended' || f.minScore ? 'job_matches!inner(*)' : 'job_matches(*)';
      const savedSel = f.view === 'saved' ? 'saved_jobs!inner(id)' : 'saved_jobs(id)';
      let q = supabase.from('job_listings').select(`*, ${inner}, ${savedSel}, applications(id, status)`);
      q = q.eq('is_hidden', f.view === 'hidden');
      if (!f.includeExpired) q = q.eq('status', 'active');
      if (f.q) q = q.textSearch('search_tsv', f.q, { type: 'websearch', config: 'english' });
      if (f.arrangement) q = q.eq('work_arrangement', f.arrangement);
      if (f.employment) q = q.eq('employment_type', f.employment);
      if (f.level) q = q.eq('experience_level', f.level);
      if (f.source) q = q.like('source_key', `${f.source}%`);
      if (f.company) q = q.ilike('company', `%${f.company}%`);
      if (f.location) q = q.ilike('location', `%${f.location}%`);
      if (f.salaryOnly) q = q.not('salary_max', 'is', null);
      if (f.maxAgeDays) q = q.gte('posted_at', new Date(Date.now() - f.maxAgeDays * 86_400_000).toISOString());
      if (f.view === 'recommended') {
        q = q.eq('job_matches.eligible', true).gte('job_matches.score', f.minScore ?? 60).order('score', { referencedTable: 'job_matches', ascending: false });
      } else if (f.minScore) {
        q = q.gte('job_matches.score', f.minScore);
      }
      q = q.order('posted_at', { ascending: false, nullsFirst: false }).limit(f.limit ?? 150);
      const rows = check(await q, 'jobs') as JobWithMatch[];
      if (f.view === 'recommended') rows.sort((a, b) => (b.job_matches[0]?.score ?? 0) - (a.job_matches[0]?.score ?? 0));
      return rows;
    },
  });
}

export function useJob(id: string) {
  return useQuery({ queryKey: keys.job(id), queryFn: async () => check(await supabase.from('job_listings').select(JOB_SELECT).eq('id', id).single(), 'job') as JobWithMatch });
}

export function useApplications() {
  return useQuery({ queryKey: keys.applications, queryFn: async () => check(await supabase.from('applications').select('*').order('updated_at', { ascending: false }).limit(500), 'applications') as Application[] });
}

export function useApplication(id: string) {
  return useQuery({
    queryKey: keys.application(id),
    queryFn: async () => {
      const [app, docs, events, messages, interviews] = await Promise.all([
        supabase.from('applications').select('*').eq('id', id).single(),
        supabase.from('application_documents').select('*').eq('application_id', id).order('version', { ascending: false }),
        supabase.from('application_events').select('*').eq('application_id', id).order('created_at', { ascending: false }),
        supabase.from('recruitment_messages').select('id, subject, from_name, from_email, received_at, category').eq('application_id', id).order('received_at', { ascending: false }),
        supabase.from('interview_schedules').select('*').eq('application_id', id).order('scheduled_at'),
      ]);
      return {
        application: check(app, 'application') as Application,
        documents: check(docs, 'documents') as ApplicationDocument[],
        events: check(events, 'events') as ApplicationEvent[],
        messages: check(messages, 'messages') as Array<Pick<RecruitmentMessage, 'id' | 'subject' | 'from_name' | 'from_email' | 'received_at' | 'category'>>,
        interviews: check(interviews, 'interviews') as Interview[],
      };
    },
  });
}

export function useResumes() {
  return useQuery({ queryKey: keys.resumes, queryFn: async () => check(await supabase.from('resumes').select('*').order('created_at', { ascending: false }), 'resumes') as Resume[] });
}

export function useVersions(resumeId?: string) {
  return useQuery({
    queryKey: keys.versions(resumeId),
    queryFn: async () => {
      let q = supabase.from('resume_versions').select('*').order('created_at', { ascending: false }).limit(200);
      if (resumeId) q = q.eq('resume_id', resumeId);
      return check(await q, 'resume versions') as ResumeVersion[];
    },
  });
}

export function useSkills() {
  return useQuery({ queryKey: keys.skills, queryFn: async () => check(await supabase.from('skills').select('*').order('name'), 'skills') as Skill[] });
}

export function usePreferences() {
  return useQuery({ queryKey: keys.preferences, queryFn: async () => check(await supabase.from('job_preferences').select('*').order('created_at'), 'preferences') as JobPreferenceRow[] });
}

export function useSources() {
  return useQuery({ queryKey: keys.sources, queryFn: async () => check(await supabase.from('job_sources').select('*').order('name'), 'sources') as JobSource[] });
}

export function useMessages(f: { category?: string; importantOnly?: boolean }) {
  return useQuery({
    queryKey: keys.messages(f),
    queryFn: async () => {
      let q = supabase.from('recruitment_messages').select('*').order('received_at', { ascending: false }).limit(200);
      if (f.category) q = q.eq('category', f.category);
      if (f.importantOnly) q = q.eq('is_important', true);
      return check(await q, 'messages') as RecruitmentMessage[];
    },
  });
}

export function useInterviews() {
  return useQuery({ queryKey: keys.interviews, queryFn: async () => check(await supabase.from('interview_schedules').select('*').order('scheduled_at', { ascending: true, nullsFirst: true }), 'interviews') as Interview[] });
}

export function useRuns(f: { workflow?: string; status?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: keys.runs(f),
    queryFn: async () => {
      let q = supabase.from('automation_runs').select('*').order('created_at', { ascending: false }).limit(f.limit ?? 100);
      if (f.workflow) q = q.eq('workflow', f.workflow);
      if (f.status) q = q.eq('status', f.status);
      return check(await q, 'runs') as AutomationRun[];
    },
  });
}

export function useNotifications() {
  return useQuery({ queryKey: keys.notifications, queryFn: async () => check(await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(60), 'notifications') as AppNotification[] });
}

export function useAiUsage() {
  return useQuery({
    queryKey: keys.aiUsage,
    queryFn: async () =>
      check(await supabase.from('ai_usage_logs').select('id, task, model, status, total_tokens, latency_ms, created_at').gte('created_at', new Date(Date.now() - 30 * 86_400_000).toISOString()).order('created_at', { ascending: false }).limit(2000), 'AI usage') as AiUsageLog[],
  });
}

export function useIntegrations(checkModels = false) {
  return useQuery({ queryKey: [...keys.integrations, checkModels], queryFn: () => api<IntegrationStatus>(`/integrations/status${checkModels ? '?check=1' : ''}`), staleTime: 60_000 });
}

/** Mutation helper with consistent toasts and cache invalidation. */
export function useAction<TVars, TResult>(fn: (v: TVars) => Promise<TResult>, opts: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[]; onSuccess?: (r: TResult) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      qc.invalidateQueries({ queryKey: keys.stats });
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(r);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Live updates: notification, run and application changes refresh the relevant queries. */
export function useRealtime(enabled: boolean) {
  const qc = useQueryClient();
  React.useEffect(() => {
    if (!enabled) return;
    const channel = supabase
      .channel('applypilot-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (payload) => {
        qc.invalidateQueries({ queryKey: keys.notifications });
        qc.invalidateQueries({ queryKey: keys.stats });
        const n = payload.new as AppNotification;
        if (n.severity === 'error') toast.error(n.title);
        else if (['high_match', 'interview', 'docs_ready', 'approval_needed'].includes(n.type)) toast(n.title, { description: n.body?.slice(0, 140) });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'automation_runs' }, () => {
        qc.invalidateQueries({ queryKey: ['runs'] });
        qc.invalidateQueries({ queryKey: keys.stats });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, (payload) => {
        qc.invalidateQueries({ queryKey: keys.applications });
        const id = (payload.new as { id?: string })?.id;
        if (id) qc.invalidateQueries({ queryKey: keys.application(id) });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, qc]);
}
