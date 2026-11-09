import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Users, Mail, Eye, PlayCircle, CheckCircle2, Clock,
  AlertTriangle, ClipboardList, TrendingUp, RefreshCw, Wifi, WifiOff,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

interface DashboardStats {
  totalCandidates: number;
  sent: number;
  opened: number;
  inProgress: number;
  completed: number;
  overdue: number;
  avgScore: number;
  supportPlans: number;
  openInterventions: number;
}

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>({
    totalCandidates: 0, sent: 0, opened: 0, inProgress: 0,
    completed: 0, overdue: 0, avgScore: 0, supportPlans: 0, openInterventions: 0,
  });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const loadStats = useCallback(async () => {
    const { data: allInvitations } = await supabase.from('assessment_invitations').select('*');
    // Test Test assessments are excluded from learner reporting.
    const invitations = (allInvitations ?? []).filter((i: any) => !i.is_test);
    const { data: plans } = await supabase.from('support_plans').select('*');
    const { data: interventions } = await supabase.from('intervention_cases').select('*');

    const today = new Date();
    const next: DashboardStats = {
      totalCandidates: invitations?.length || 0,
      sent: invitations?.filter((i) => i.status === 'sent').length || 0,
      opened: invitations?.filter((i) => i.status === 'opened').length || 0,
      inProgress: invitations?.filter((i) => i.status === 'in_progress').length || 0,
      completed: invitations?.filter((i) => i.status === 'completed').length || 0,
      overdue: invitations?.filter((i) => i.due_date && new Date(i.due_date) < today && i.status !== 'completed').length || 0,
      avgScore: 0,
      supportPlans: plans?.length || 0,
      openInterventions: interventions?.filter((i) => i.status === 'open').length || 0,
    };

    const completedInv = invitations?.filter((i) => i.status === 'completed') || [];
    if (completedInv.length > 0) {
      const { data: invAssessments } = await supabase
        .from('invitation_assessments')
        .select('individual_score')
        .in('invitation_id', completedInv.map((i) => i.id));
      const scores = invAssessments?.filter((a) => a.individual_score != null).map((a) => Number(a.individual_score)) || [];
      next.avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    }

    setStats(next);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    loadStats();

    // Dispatch both queue processors on mount so any pending jobs run without admin intervention
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.access_token) return;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      };
      const base = import.meta.env.VITE_SUPABASE_URL;
      fetch(`${base}/functions/v1/process-email-queue`, { method: 'POST', headers }).catch(() => {});
      fetch(`${base}/functions/v1/process-axcelerate-queue`, { method: 'POST', headers }).catch(() => {});
    });

    // Subscribe to real-time changes on assessment_invitations
    const channel = supabase
      .channel('dashboard-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assessment_invitations' },
        () => { loadStats(); },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'support_plans' },
        () => { loadStats(); },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'intervention_cases' },
        () => { loadStats(); },
      )
      .subscribe((status) => {
        setRealtimeConnected(status === 'SUBSCRIBED');
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadStats]);

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-slate-400">Loading dashboard...</div>;
  }

  const statCards = [
    { label: 'Total Candidates', value: stats.totalCandidates, icon: Users, color: 'text-primary-600', bg: 'bg-primary-50' },
    { label: 'Invitations Sent', value: stats.sent, icon: Mail, color: 'text-slate-600', bg: 'bg-slate-100' },
    { label: 'Opened', value: stats.opened, icon: Eye, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'In Progress', value: stats.inProgress, icon: PlayCircle, color: 'text-amber-600', bg: 'bg-amber-50' },
    { label: 'Completed', value: stats.completed, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { label: 'Overdue', value: stats.overdue, icon: Clock, color: 'text-rose-600', bg: 'bg-rose-50' },
    { label: 'Support Plans', value: stats.supportPlans, icon: ClipboardList, color: 'text-accent-600', bg: 'bg-accent-50' },
    { label: 'Open Interventions', value: stats.openInterventions, icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-50' },
    { label: 'Average Score', value: `${stats.avgScore}%`, icon: TrendingUp, color: 'text-primary-600', bg: 'bg-primary-50' },
  ];

  const funnel = [
    { label: 'Sent', value: stats.sent + stats.opened + stats.inProgress + stats.completed, color: 'bg-slate-400' },
    { label: 'Opened', value: stats.opened + stats.inProgress + stats.completed, color: 'bg-blue-500' },
    { label: 'In Progress', value: stats.inProgress + stats.completed, color: 'bg-amber-500' },
    { label: 'Completed', value: stats.completed, color: 'bg-emerald-500' },
  ];
  const maxFunnel = funnel[0]?.value || 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium ${realtimeConnected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {realtimeConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {realtimeConnected ? 'Live' : 'Offline'}
          </span>
          {lastUpdated && (
            <span className="text-xs text-slate-400">Updated {lastUpdated.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          )}
        </div>
        <button onClick={loadStats} className="btn-ghost text-xs" title="Refresh now">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <div className={`w-10 h-10 rounded-lg ${card.bg} flex items-center justify-center`}>
                  <Icon className={`w-5 h-5 ${card.color}`} />
                </div>
              </div>
              <div className="text-2xl font-bold text-slate-900">{card.value}</div>
              <div className="text-sm text-slate-500 mt-0.5">{card.label}</div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card p-6">
          <h3 className="text-base font-semibold text-slate-900 mb-4">Assessment Funnel</h3>
          <div className="space-y-3">
            {funnel.map((stage) => (
              <div key={stage.label}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium text-slate-600">{stage.label}</span>
                  <span className="text-sm font-semibold text-slate-900">{stage.value}</span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${stage.color} rounded-full transition-all duration-500`}
                    style={{ width: `${(stage.value / maxFunnel) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-6">
          <h3 className="text-base font-semibold text-slate-900 mb-4">Quick Actions</h3>
          <div className="space-y-2">
            <div className="text-sm text-slate-500">
              Use the sidebar to navigate to specific sections. Send combined LLN + Digital quiz
              invitations from the Candidates page, review results, manage support plans, and
              generate ASQA compliance reports.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
