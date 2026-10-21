import { Check } from 'lucide-react';
import { Checkbox as CheckboxPrimitive, Label as LabelPrimitive, Switch as SwitchPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted/80 focus-visible:border-jade focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade/25 disabled:opacity-60 aria-[invalid=true]:border-rose';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(control, 'h-8', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-20 py-2 leading-relaxed', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(control, 'h-8 appearance-auto pr-7', className)} {...props}>
    {children}
  </select>
));
NativeSelect.displayName = 'NativeSelect';

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn('text-[13px] font-medium text-ink-2', className)} {...props} />;
}

/** Label + control + optional hint/error, with ids wired for screen readers. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: React.ReactNode; error?: string | null; children: React.ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>; className?: string }) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const child = React.cloneElement(children, { id, 'aria-describedby': hint || error ? hintId : undefined, 'aria-invalid': error ? true : undefined });
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {child}
      {(error || hint) && (
        <p id={hintId} className={cn('text-xs', error ? 'text-rose' : 'text-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-line-strong transition-colors data-[state=checked]:bg-jade disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn('flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface data-[state=checked]:border-jade data-[state=checked]:bg-jade data-[state=checked]:text-jade-ink', className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/** A labelled switch row used throughout settings. */
export function SwitchRow({ label, description, checked, onCheckedChange, disabled }: { label: string; description?: React.ReactNode; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
