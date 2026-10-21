import type {
  ApplicationStatus,
  AutomationMode,
  EmailCategory,
  EmploymentType,
  ExperienceLevel,
  JobPreference,
  PhEligibility,
  ResumeData,
  RunStatus,
  SalaryPeriod,
  WorkArrangement,
  WorkflowKey,
} from '@applypilot/core';

/** Row shapes mirror supabase/migrations. */

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  location: string;
  headline: string;
  timezone: string;
  portfolio_url: string;
  linkedin_url: string;
  github_url: string;
  verified_resume_version_id: string | null;
  onboarded_at: string | null;
}

export interface AutomationRules {
  id: string;
  mode: AutomationMode;
  paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
  auto_apply_enabled: boolean;
  auto_apply_opt_in_at: string | null;
  allowed_sources: string[];
  min_match_score: number;
  min_salary_hourly_usd: number | null;
  preferred_categories: string[];
  max_daily_submissions: number;
  excluded_companies: string[];
  resume_selection: 'primary' | 'tailored';
  require_document_approval: boolean;
  auto_prepare_min_score: number;
  follow_up_after_days: number;
  notify_min_score: number;
  ai_daily_request_budget: number;
  email_notifications: boolean;
  telegram_notifications: boolean;
  n8n_last_seen_at: string | null;
}

export interface Resume {
  id: string;
  title: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  extracted_text: string | null;
  status: 'uploaded' | 'extracting' | 'extracted' | 'analyzing' | 'analyzed' | 'failed';
  analysis: ResumeAnalysis | null;
  analysis_error: string | null;
  analyzed_at: string | null;
  is_primary: boolean;
  created_at: string;
}

export interface ResumeAnalysis {
  version_id: string;
  completeness: { score: number; missing: string[]; warnings: string[] };
  ai: {
    overall_score: number;
    summary: string;
    strengths: string[];
    issues: Array<{ section: string; severity: 'high' | 'medium' | 'low'; issue: string; suggestion: string }>;
    missing_information: string[];
    ats_tips: string[];
  } | null;
  ai_error: string | null;
  model: string | null;
  analyzed_at: string;
}

export interface ResumeChange {
  section: string;
  before: string;
  after: string;
  reason: string;
}

export interface GuardViolation {
  section: string;
  item: string;
  action: 'removed' | 'restored' | 'flagged';
  reason: string;
}

export interface ResumeVersion {
  id: string;
  resume_id: string;
  version_number: number;
  label: string;
  kind: 'extracted' | 'manual' | 'ai_enhanced' | 'tailored';
  content: ResumeData;
  based_on_version_id: string | null;
  job_id: string | null;
  ai_changes: ResumeChange[];
  guard_violations: GuardViolation[];
  status: 'draft' | 'approved' | 'rejected';
  is_verified: boolean;
  model: string | null;
  created_at: string;
}

export interface Skill {
  id: string;
  name: string;
  normalized_name: string;
  category: string;
  source: 'resume' | 'manual';
  verified: boolean;
}

export type JobPreferenceRow = JobPreference & { id: string; created_at: string };

export interface JobSource {
  id: string;
  key: string;
  kind: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  automation_allowed: boolean;
  last_run_at: string | null;
  last_status: 'ok' | 'partial' | 'error' | 'skipped' | null;
  last_error: string | null;
  last_job_count: number | null;
}

export interface JobListing {
  id: string;
  source_key: string;
  external_id: string;
  title: string;
  company: string;
  company_url: string | null;
  location: string;
  work_arrangement: WorkArrangement;
  employment_type: EmploymentType;
  experience_level: ExperienceLevel;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: SalaryPeriod | null;
  salary_text: string | null;
  candidate_locations: string | null;
  ph_eligibility: PhEligibility;
  description: string;
  requirements: string[];
  tags: string[];
  apply_url: string;
  posted_at: string | null;
  expires_at: string | null;
  discovered_at: string;
  status: 'active' | 'expired' | 'closed';
  is_hidden: boolean;
}

export interface CriterionScore {
  score: number;
  source: 'deterministic' | 'ai' | 'blended';
  note: string;
}

export interface EligibilityCheck {
  rule: string;
  outcome: 'pass' | 'fail' | 'unknown' | 'skipped';
  mandatory: boolean;
  detail: string;
}

export interface JobMatch {
  id: string;
  job_id: string;
  preference_id: string | null;
  status: 'pending' | 'scored' | 'failed' | 'ineligible';
  score: number | null;
  deterministic_score: number | null;
  ai_score: number | null;
  breakdown: Record<string, CriterionScore>;
  eligibility: { passed: boolean; checks: EligibilityCheck[]; failures: string[]; warnings: string[]; profile?: string; ai_note?: string | null };
  eligible: boolean | null;
  matched_skills: string[];
  missing_skills: string[];
  missing_qualifications: string[];
  explanation: string | null;
  suggestions: string[];
  recommendation: 'apply' | 'consider' | 'skip' | null;
  model: string | null;
  scored_at: string | null;
}

export type JobWithMatch = JobListing & { job_matches: JobMatch[]; saved_jobs?: Array<{ id: string }>; applications?: Array<{ id: string; status: ApplicationStatus }> };

export interface Application {
  id: string;
  job_id: string | null;
  status: ApplicationStatus;
  status_source: string;
  mode: AutomationMode;
  channel: 'manual' | 'email' | 'playwright' | 'ats_portal';
  company: string;
  job_title: string;
  apply_url: string | null;
  source_key: string | null;
  match_score: number | null;
  resume_version_id: string | null;
  cover_letter_document_id: string | null;
  documents_approved_at: string | null;
  submission_approved_at: string | null;
  submitted_at: string | null;
  confirmed_by: 'evidence' | 'manual' | 'email' | null;
  submission_evidence: Record<string, unknown> | null;
  last_error: string | null;
  needs_manual_action: boolean;
  manual_action_reason: string | null;
  follow_up_interval_days: number | null;
  next_follow_up_at: string | null;
  last_follow_up_at: string | null;
  follow_ups_sent: number;
  recruiter_name: string | null;
  recruiter_email: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ApplicationDocument {
  id: string;
  application_id: string | null;
  job_id: string | null;
  kind: 'resume' | 'cover_letter' | 'email' | 'screening_answers' | 'follow_up' | 'reply';
  title: string;
  content_text: string;
  content_json: Record<string, unknown> | null;
  version: number;
  status: 'draft' | 'approved' | 'rejected' | 'sent';
  ai_generated: boolean;
  model: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface ApplicationEvent {
  id: string;
  application_id: string;
  type: string;
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus | null;
  message: string;
  metadata: Record<string, unknown>;
  actor: string;
  created_at: string;
}

export interface RecruitmentMessage {
  id: string;
  gmail_message_id: string;
  thread_id: string | null;
  from_email: string;
  from_name: string;
  subject: string;
  snippet: string;
  body_text: string;
  received_at: string;
  category: EmailCategory | null;
  confidence: number | null;
  classification: Record<string, unknown> | null;
  classified_by: 'ai' | 'heuristic' | 'user' | null;
  application_id: string | null;
  status_update: { update: boolean; suggested?: boolean; to: ApplicationStatus | null; reason: string } | null;
  sender_verified: boolean;
  processed_status: 'new' | 'classified' | 'ignored' | 'error';
  suggested_reply: string | null;
  is_important: boolean;
  is_read: boolean;
}

export interface Interview {
  id: string;
  application_id: string | null;
  message_id: string | null;
  title: string;
  stage: 'screening' | 'technical' | 'hr' | 'final' | 'other';
  scheduled_at: string | null;
  duration_minutes: number | null;
  timezone: string;
  location: string;
  meeting_url: string;
  interviewer: string;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled' | 'needs_confirmation';
  source: 'email' | 'manual';
  notes: string;
}

export interface AutomationRun {
  id: string;
  workflow: WorkflowKey;
  status: RunStatus;
  trigger: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  stats: Record<string, unknown>;
  item_errors: Array<Record<string, unknown>>;
  error: string | null;
  attempt: number;
  max_attempts: number;
  parent_run_id: string | null;
  n8n_execution_id: string | null;
  cancel_requested: boolean;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface AppNotification {
  id: string;
  type: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface AiUsageLog {
  id: string;
  task: string;
  model: string;
  status: string;
  total_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface DashboardStats {
  jobs_total: number;
  jobs_new_24h: number;
  high_matches: number;
  saved: number;
  submitted: number;
  pending: number;
  awaiting_action: number;
  interviews_upcoming: number;
  rejected: number;
  offers: number;
  runs_failed_24h: number;
  runs_active: number;
  unread_notifications: number;
  unread_messages: number;
}

export interface IntegrationStatus {
  supabase: boolean;
  gemini: boolean;
  gmail_oauth: boolean;
  token_encryption: boolean;
  n8n_push: boolean;
  github_runner: boolean;
  models: { fast: string; quality: string; api: string };
  model_checks: Record<string, { ok: boolean; detail: string }> | null;
  gmail: { email: string; status: string; last_sync_at: string | null; last_error: string | null; scopes: string[] } | null;
  n8n_last_seen_at: string | null;
}
