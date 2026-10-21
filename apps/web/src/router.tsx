import { lazy } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { AppLayout, PageSkeleton } from './components/layout/app-layout';
import { useAuth } from './providers/auth';
import LoginPage from './pages/login';

const Dashboard = lazy(() => import('./pages/dashboard'));
const Jobs = lazy(() => import('./pages/jobs'));
const JobDetail = lazy(() => import('./pages/job-detail'));
const ResumePage = lazy(() => import('./pages/resume'));
const Studio = lazy(() => import('./pages/studio'));
const Applications = lazy(() => import('./pages/applications'));
const ApplicationDetail = lazy(() => import('./pages/application-detail'));
const Inbox = lazy(() => import('./pages/inbox'));
const Interviews = lazy(() => import('./pages/interviews'));
const Analytics = lazy(() => import('./pages/analytics'));
const Automation = lazy(() => import('./pages/automation'));
const Integrations = lazy(() => import('./pages/integrations'));
const SettingsPage = lazy(() => import('./pages/settings'));

function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8"><PageSkeleton /></div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Dashboard /> },
          { path: 'discover', element: <Jobs view="all" /> },
          { path: 'recommended', element: <Jobs view="recommended" /> },
          { path: 'saved', element: <Jobs view="saved" /> },
          { path: 'jobs/:id', element: <JobDetail /> },
          { path: 'resume', element: <ResumePage /> },
          { path: 'studio', element: <Studio /> },
          { path: 'applications', element: <Applications /> },
          { path: 'applications/:id', element: <ApplicationDetail /> },
          { path: 'inbox', element: <Inbox /> },
          { path: 'interviews', element: <Interviews /> },
          { path: 'analytics', element: <Analytics /> },
          { path: 'automation', element: <Automation /> },
          { path: 'integrations', element: <Integrations /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);
