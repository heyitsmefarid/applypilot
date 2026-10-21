import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { currentUserId, supabase } from '@/lib/supabase';
import type { JobWithMatch } from '@/lib/types';
import { errorMessage } from '@/lib/utils';
import { keys } from './data';

/** Save/unsave and hide/unhide, shared by every job list. */
export function useJobActions() {
  const qc = useQueryClient();
  const refresh = (id: string) => {
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: keys.job(id) });
    qc.invalidateQueries({ queryKey: keys.stats });
  };
  return {
    async toggleSave(job: JobWithMatch) {
      try {
        if (job.saved_jobs?.length) {
          const { error } = await supabase.from('saved_jobs').delete().eq('job_id', job.id);
          if (error) throw error;
          toast('Removed from saved jobs');
        } else {
          const { error } = await supabase.from('saved_jobs').insert({ job_id: job.id, user_id: await currentUserId() });
          if (error) throw error;
          toast.success('Job saved');
        }
        refresh(job.id);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    async toggleHide(job: JobWithMatch) {
      const { error } = await supabase.from('job_listings').update({ is_hidden: !job.is_hidden, hidden_reason: job.is_hidden ? null : 'Hidden by you' }).eq('id', job.id);
      if (error) return toast.error(error.message);
      toast(job.is_hidden ? 'Job is visible again' : 'Job hidden', job.is_hidden ? undefined : { action: { label: 'Undo', onClick: () => supabase.from('job_listings').update({ is_hidden: false }).eq('id', job.id).then(() => refresh(job.id)) } });
      refresh(job.id);
    },
  };
}
