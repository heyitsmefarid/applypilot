import {
  BarChart3,
  Bell,
  Bookmark,
  Bot,
  Briefcase,
  CalendarClock,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  PlugZap,
  Search,
  Settings,
  Star,
  Sun,
  Wand2,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { keys, useNotifications, useRealtime, useStats } from '@/hooks/data';
import { supabase } from '@/lib/supabase';
import { cn, timeAgo } from '@/lib/utils';
import { useAuth } from '@/providers/auth';
import { useTheme } from '@/providers/theme';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '../ui/overlay';
import { Annunciator } from './annunciator';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: (s: ReturnType<typeof useStats>['data']) => number | undefined;
}

const NAV: Array<{ group: string; items: NavItem[] }> = [
  { group: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }, { to: '/analytics', label: 'Analytics', icon: BarChart3 }] },
  {
    group: 'Jobs',
    items: [
      { to: '/discover', label: 'Discover jobs', icon: Search },
      { to: '/recommended', label: 'Recommended', icon: Star, count: (s) => s?.high_matches },
      { to: '/saved', label: 'Saved jobs', icon: Bookmark, count: (s) => s?.saved },
    ],
  },
  { group: 'Resume', items: [{ to: '/resume', label: 'My resume', icon: FileText }, { to: '/studio', label: 'Resume studio', icon: Wand2 }] },
  {
    group: 'Pipeline',
    items: [
      { to: '/applications', label: 'Applications', icon: Briefcase, count: (s) => s?.awaiting_action },
      { to: '/inbox', label: 'Recruitment inbox', icon: Inbox, count: (s) => s?.unread_messages },
      { to: '/interviews', label: 'Interviews', icon: CalendarClock, count: (s) => s?.interviews_upcoming },
    ],
  },
  {
    group: 'System',
    items: [
      { to: '/automation', label: 'Automation center', icon: Bot, count: (s) => s?.runs_failed_24h },
      { to: '/integrations', label: 'Integrations', icon: PlugZap },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

function readCollapsed() {
  try {
    return localStorage.getItem('applypilot-sidebar') === 'collapsed';
  } catch {
    return false;
  }
}

function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle?: () => void; onNavigate?: () => void }) {
  const stats = useStats();
  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <Link to="/" onClick={onNavigate} className={cn('flex h-14 items-center gap-2 px-4', collapsed && 'justify-center px-0')}>
        <img src="/favicon.svg" alt="" className="size-7" />
        {!collapsed && <span className="type-display text-[17px]">ApplyPilot</span>}
      </Link>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {NAV.map((g) => (
          <div key={g.group} className="mt-3 first:mt-1">
            {!collapsed && <p className="px-2 pb-1 text-[11.5px] font-medium text-muted">{g.group}</p>}
            {collapsed && <div className="mx-auto mb-1 h-px w-6 bg-line" aria-hidden />}
            <ul className="grid gap-0.5">
              {g.items.map((item) => {
                const n = item.count?.(stats.data);
                const link = (
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'relative flex h-8 items-center gap-2.5 rounded-[var(--radius-control)] px-2 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink',
                        isActive && 'bg-surface-2 font-semibold text-ink before:absolute before:-left-2 before:top-1.5 before:h-5 before:w-[3px] before:rounded-r before:bg-jade',
                        collapsed && 'justify-center px-0',
                      )
                    }
                  >
                    <item.icon className="size-4 shrink-0" />
                    {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                    {!collapsed && n ? <span className="figures rounded-full bg-surface px-1.5 text-[11px] text-muted ring-1 ring-line">{n}</span> : null}
                    {collapsed && n ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-jade" aria-label={`${n} items`} /> : null}
                  </NavLink>
                );
                return <li key={item.to}>{collapsed ? <Tooltip content={item.label}>{link}</Tooltip> : link}</li>;
              })}
            </ul>
          </div>
        ))}
      </div>
      {onToggle && (
        <button onClick={onToggle} className="m-2 flex h-8 items-center justify-center gap-2 rounded text-xs text-muted hover:bg-surface-2 hover:text-ink" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" /> Collapse</>}
        </button>
      )}
    </nav>
  );
}

function Notifications() {
  const { data = [] } = useNotifications();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.notifications });
    qc.invalidateQueries({ queryKey: keys.stats });
  };
  const unread = data.filter((n) => !n.read_at).length;
  const markAll = async () => {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
    refresh();
  };
  const tone = { info: 'bg-sky', success: 'bg-jade', warning: 'bg-amber', error: 'bg-rose' };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative">
          <Bell />
          {unread > 0 && <span className="figures absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-jade px-1 text-[10px] font-semibold text-jade-ink">{unread > 9 ? '9+' : unread}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(380px,calc(100vw-1.5rem))]">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <p className="text-[13px] font-semibold">Notifications</p>
          {unread > 0 && (
            <button className="text-xs text-jade hover:underline" onClick={markAll}>
              Mark all as read
            </button>
          )}
        </div>
        <ul className="max-h-[60vh] overflow-y-auto">
          {data.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">You're all caught up.</li>}
          {data.map((n) => (
            <li key={n.id}>
              <button
                className={cn('flex w-full gap-2.5 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-surface-2', n.read_at && 'opacity-70')}
                onClick={async () => {
                  if (!n.read_at) {
                    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
                    refresh();
                  }
                  if (n.link) navigate(n.link);
                }}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-line-strong' : tone[n.severity])} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-snug">{n.title}</span>
                  {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>}
                  <span className="mt-0.5 block text-[11px] text-muted">{timeAgo(n.created_at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function AppLayout() {
  const { signOut, session } = useAuth();
  const { theme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = React.useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  useRealtime(Boolean(session));

  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem('applypilot-sidebar', c ? 'expanded' : 'collapsed');
      } catch {
        /* ignore */
      }
      return !c;
    });
  const isDark = theme === 'dark' || (theme === 'system' && document.documentElement.classList.contains('dark'));

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className={cn('sticky top-0 hidden h-dvh shrink-0 border-r border-line bg-surface transition-[width] duration-200 lg:block', collapsed ? 'w-[60px]' : 'w-[232px]')}>
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-[#0c1117]/45" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[260px] border-r border-line bg-surface">
            <button className="absolute right-2 top-3 rounded p-1.5 text-muted hover:bg-surface-2" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
              <X className="size-4" />
            </button>
            <Sidebar collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-paper/90 px-3 backdrop-blur sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <div className="flex-1" />
          <Annunciator />
          <div className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
          <Notifications />
          <Tooltip content={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
            <Button variant="ghost" size="icon" onClick={() => setTheme(isDark ? 'light' : 'dark')} aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
              {isDark ? <Sun /> : <Moon />}
            </Button>
          </Tooltip>
          <Tooltip content={`Sign out ${session?.user.email ?? ''}`}>
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
              <LogOut />
            </Button>
          </Tooltip>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-6">
          <React.Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </React.Suspense>
        </main>
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-56 animate-pulse rounded bg-surface-2" />
      <div className="h-24 animate-pulse rounded-[var(--radius-panel)] bg-surface-2" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-64 animate-pulse rounded-[var(--radius-panel)] bg-surface-2" />
        <div className="h-64 animate-pulse rounded-[var(--radius-panel)] bg-surface-2" />
      </div>
    </div>
  );
}

