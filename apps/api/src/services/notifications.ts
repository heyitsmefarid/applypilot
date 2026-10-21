import type { Db } from '../lib/supabase.js';

export type NotificationType =
  | 'high_match'
  | 'docs_ready'
  | 'approval_needed'
  | 'application_update'
  | 'interview'
  | 'email'
  | 'automation_error'
  | 'report'
  | 'follow_up'
  | 'system';

export interface NewNotification {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'error';
  dedupe_key?: string | null;
  metadata?: Record<string, unknown>;
}

/** Inserts a notification; a repeated dedupe_key is silently ignored (idempotent). */
export async function notify(db: Db, userId: string, n: NewNotification): Promise<boolean> {
  const row = {
    user_id: userId,
    type: n.type,
    title: n.title.slice(0, 200),
    body: (n.body ?? '').slice(0, 2000),
    link: n.link ?? null,
    severity: n.severity ?? 'info',
    dedupe_key: n.dedupe_key ?? null,
    metadata: n.metadata ?? {},
  };
  const query = n.dedupe_key
    ? db.from('notifications').upsert(row, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true }).select('id')
    : db.from('notifications').insert(row).select('id');
  const { data, error } = await query;
  if (error) {
    console.error('[notify] failed', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
