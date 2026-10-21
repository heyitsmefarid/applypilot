export const APPLICATION_STATUSES = [
  'discovered',
  'saved',
  'draft_prepared',
  'awaiting_approval',
  'submission_in_progress',
  'applied',
  'assessment',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'closed',
  'submission_failed',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  discovered: 'Discovered',
  saved: 'Saved',
  draft_prepared: 'Draft Prepared',
  awaiting_approval: 'Awaiting Approval',
  submission_in_progress: 'Submission In Progress',
  applied: 'Applied',
  assessment: 'Assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  closed: 'Closed',
  submission_failed: 'Submission Failed',
};

/** Statuses that mean an application has actually reached the employer. */
export const SUBMITTED_STATUSES: readonly ApplicationStatus[] = [
  'applied',
  'assessment',
  'interview',
  'offer',
  'rejected',
];

/** Statuses that are waiting for a reply from the employer. */
export const PENDING_STATUSES: readonly ApplicationStatus[] = ['applied', 'assessment'];

export const AUTOMATION_MODES = ['manual', 'approval', 'auto'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const SUBMISSION_CHANNELS = ['manual', 'email', 'playwright', 'ats_portal'] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];

export const WORKFLOWS = [
  'job_discovery',
  'resume_analysis',
  'job_matching',
  'application_prep',
  'application_submit',
  'gmail_sync',
  'follow_up',
  'reports',
  'error_recovery',
] as const;
export type WorkflowKey = (typeof WORKFLOWS)[number];

export const WORKFLOW_LABELS: Record<WorkflowKey, string> = {
  job_discovery: 'Job Discovery',
  resume_analysis: 'Resume Analysis',
  job_matching: 'AI Job Matching',
  application_prep: 'Application Preparation',
  application_submit: 'Application Submission',
  gmail_sync: 'Gmail Monitoring',
  follow_up: 'Follow-up',
  reports: 'Notifications & Reports',
  error_recovery: 'Error Recovery',
};

/** n8n webhook path each workflow listens on (stable across imports). */
export const WORKFLOW_WEBHOOK_PATHS: Record<WorkflowKey, string> = {
  job_discovery: 'applypilot/job-discovery',
  resume_analysis: 'applypilot/resume-analysis',
  job_matching: 'applypilot/job-matching',
  application_prep: 'applypilot/application-prep',
  application_submit: 'applypilot/application-submit',
  gmail_sync: 'applypilot/gmail-sync',
  follow_up: 'applypilot/follow-up',
  reports: 'applypilot/reports',
  error_recovery: 'applypilot/error-recovery',
};

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['schedule', 'dashboard', 'webhook', 'event', 'retry', 'cron'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const WORK_ARRANGEMENTS = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export type WorkArrangement = (typeof WORK_ARRANGEMENTS)[number];

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'freelance', 'internship', 'unknown'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EXPERIENCE_LEVELS = ['internship', 'entry', 'junior', 'mid', 'senior', 'unknown'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const SALARY_PERIODS = ['hour', 'day', 'week', 'month', 'year'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const PH_ELIGIBILITY = ['eligible', 'ineligible', 'unknown'] as const;
export type PhEligibility = (typeof PH_ELIGIBILITY)[number];

export const EMAIL_CATEGORIES = [
  'job_alert',
  'acknowledgment',
  'assessment',
  'interview',
  'offer',
  'rejection',
  'recruiter_outreach',
  'follow_up',
  'other',
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const EMAIL_CATEGORY_LABELS: Record<EmailCategory, string> = {
  job_alert: 'Job alert',
  acknowledgment: 'Application received',
  assessment: 'Assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejection: 'Rejection',
  recruiter_outreach: 'Recruiter outreach',
  follow_up: 'Follow-up',
  other: 'Other',
};

export const DOCUMENT_KINDS = ['resume', 'cover_letter', 'email', 'screening_answers', 'follow_up', 'reply'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const AI_TASKS = [
  'resume_extract',
  'resume_analyze',
  'resume_enhance',
  'resume_tailor',
  'match',
  'cover_letter',
  'application_email',
  'screening_answers',
  'email_classify',
  'reply_draft',
  'follow_up',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const SOURCE_KINDS = [
  'remotive',
  'arbeitnow',
  'jobicy',
  'himalayas',
  'greenhouse',
  'lever',
  'ashby',
  'gmail_alert',
  'manual',
  'demo',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Confidence an email classification needs before it may change an application status. */
export const EMAIL_STATUS_UPDATE_MIN_CONFIDENCE = 0.85;

/** Score ceiling applied when a mandatory eligibility rule fails. */
export const INELIGIBLE_SCORE_CAP = 35;
