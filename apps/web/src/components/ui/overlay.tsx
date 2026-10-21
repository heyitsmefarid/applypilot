import { X } from 'lucide-react';
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive, DropdownMenu as MenuPrimitive, Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

const overlay = 'fixed inset-0 z-50 bg-[#0c1117]/45 data-[state=open]:animate-in data-[state=open]:fade-in-0';
const panel =
  'fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[0_24px_60px_-20px_rgba(12,17,23,0.45)]';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ title, description, children, className, wide }: { title: string; description?: React.ReactNode; children: React.ReactNode; className?: string; wide?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content className={cn(panel, wide ? 'max-w-3xl' : 'max-w-lg', 'max-h-[88vh] overflow-y-auto', className)}>
        <div className="grid gap-1 pr-8">
          <DialogPrimitive.Title className="type-display text-lg">{title}</DialogPrimitive.Title>
          {description ? <DialogPrimitive.Description className="text-[13px] text-muted">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
        </div>
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close">
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">{children}</div>;
}

/**
 * Confirmation for consequential actions. The confirm button repeats the action name
 * ("Submit application"), never a generic "OK".
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
  open,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => unknown;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  return (
    <AlertPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      {trigger && <AlertPrimitive.Trigger asChild>{trigger}</AlertPrimitive.Trigger>}
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={overlay} />
        <AlertPrimitive.Content className={cn(panel, 'max-w-md')}>
          <AlertPrimitive.Title className="type-display text-lg">{title}</AlertPrimitive.Title>
          <AlertPrimitive.Description asChild>
            <div className="text-[13px] leading-relaxed text-ink-2">{description}</div>
          </AlertPrimitive.Description>
          <DialogFooter>
            <AlertPrimitive.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </AlertPrimitive.Cancel>
            <Button
              variant={danger ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({ children, align = 'end' }: { children: React.ReactNode; align?: 'start' | 'end' | 'center' }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content align={align} sideOffset={6} className="z-50 min-w-44 rounded-[var(--radius-control)] border border-line bg-surface p-1 shadow-[0_12px_32px_-12px_rgba(12,17,23,0.35)]">
        {children}
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, danger, ...props }: React.ComponentProps<typeof MenuPrimitive.Item> & { danger?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn('flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-muted', danger && 'text-rose', className)}
      {...props}
    />
  );
}

export const DropdownMenuSeparator = () => <MenuPrimitive.Separator className="my-1 h-px bg-line" />;

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({ children, className, align = 'end' }: { children: React.ReactNode; className?: string; align?: 'start' | 'end' | 'center' }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content align={align} sideOffset={8} className={cn('z-50 rounded-[var(--radius-panel)] border border-line bg-surface shadow-[0_16px_40px_-16px_rgba(12,17,23,0.4)]', className)}>
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export function Tooltip({ content, children }: { content: React.ReactNode; children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content sideOffset={6} className="z-50 max-w-64 rounded bg-ink px-2 py-1 text-xs text-paper">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
