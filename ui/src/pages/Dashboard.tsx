import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { groupBy } from "../lib/groupBy";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { IssueGroupHeader } from "../components/IssueGroupHeader";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

const DASHBOARD_HEARTBEAT_RUN_LIMIT = 100;
const LS_GROUP_BY_KEY = "paperclip.dashboard.groupBy";
const LS_GROUP_OPEN_PREFIX = "paperclip.dashboard.group.";

type DashboardGroupBy = "flat" | "grouped";

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function readLsGroupBy(): DashboardGroupBy {
  try {
    const v = localStorage.getItem(LS_GROUP_BY_KEY);
    if (v === "flat" || v === "grouped") return v;
  } catch {
    // ignore
  }
  return "flat";
}

function readLsGroupOpen(key: string, defaultOpen: boolean): boolean {
  try {
    const v = localStorage.getItem(`${LS_GROUP_OPEN_PREFIX}${key}.open`);
    if (v === "true") return true;
    if (v === "false") return false;
  } catch {
    // ignore
  }
  return defaultOpen;
}

function writeLs(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

interface IssueGroup {
  key: string;
  label: string;
  issues: Issue[];
  hasInProgress: boolean;
  statusCounts: Record<string, number>;
}

function buildIssueGroups(issues: Issue[], agentMap: Map<string, Agent>): IssueGroup[] {
  const grouped = groupBy(issues, (issue) => {
    if (issue.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
    if (issue.assigneeUserId) return "humans";
    return "unassigned";
  });

  const groups: IssueGroup[] = Object.entries(grouped).map(([key, groupIssues]) => {
    const statusCounts: Record<string, number> = {};
    let hasInProgress = false;
    for (const issue of groupIssues) {
      statusCounts[issue.status] = (statusCounts[issue.status] ?? 0) + 1;
      if (issue.status === "in_progress") hasInProgress = true;
    }

    let label: string;
    if (key === "unassigned") {
      label = "Unassigned";
    } else if (key === "humans") {
      label = "Humans";
    } else {
      const agentId = key.slice("agent:".length);
      label = agentMap.get(agentId)?.name ?? agentId.slice(0, 8);
    }

    return { key, label, issues: groupIssues, hasInProgress, statusCounts };
  });

  // Sort: in_progress agents first, then by issue count desc, unassigned/humans at tail
  groups.sort((a, b) => {
    const aTail = a.key === "unassigned" || a.key === "humans";
    const bTail = b.key === "unassigned" || b.key === "humans";
    if (aTail !== bTail) return aTail ? 1 : -1;
    if (a.hasInProgress !== b.hasInProgress) return a.hasInProgress ? -1 : 1;
    return b.issues.length - a.issues.length;
  });

  return groups;
}

function StatusBreakdown({ counts }: { counts: Record<string, number> }) {
  const STATUS_ORDER = ["in_progress", "todo", "blocked", "in_review", "done"];
  const STATUS_LABEL: Record<string, string> = {
    in_progress: "in progress",
    todo: "todo",
    blocked: "blocked",
    in_review: "in review",
    done: "done",
    backlog: "backlog",
    cancelled: "cancelled",
  };

  const parts = STATUS_ORDER
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${counts[s]} ${STATUS_LABEL[s] ?? s}`);

  // Include any statuses not in STATUS_ORDER
  for (const [s, n] of Object.entries(counts)) {
    if (!STATUS_ORDER.includes(s) && n > 0) {
      parts.push(`${n} ${STATUS_LABEL[s] ?? s}`);
    }
  }

  if (parts.length === 0) return null;

  return (
    <span className="text-xs text-muted-foreground font-normal normal-case tracking-normal">
      {parts.join(" · ")}
    </span>
  );
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const [dashGroupBy, setDashGroupBy] = useState<DashboardGroupBy>(readLsGroupBy);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.heartbeats(selectedCompanyId!), "limit", DASHBOARD_HEARTBEAT_RUN_LIMIT],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, DASHBOARD_HEARTBEAT_RUN_LIMIT),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const issueGroups = useMemo(() => {
    if (dashGroupBy !== "grouped" || recentIssues.length === 0) return [];
    return buildIssueGroups(recentIssues.slice(0, 10), agentMap);
  }, [dashGroupBy, recentIssues, agentMap]);

  // Initialize openGroups from localStorage when groups become available
  useEffect(() => {
    if (issueGroups.length === 0) return;
    setOpenGroups((prev) => {
      const next = { ...prev };
      for (const group of issueGroups) {
        if (!(group.key in next)) {
          next[group.key] = readLsGroupOpen(group.key, true);
        }
      }
      return next;
    });
  }, [issueGroups]);

  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeLs(`${LS_GROUP_OPEN_PREFIX}${key}.open`, String(next[key]));
      return next;
    });
  }, []);

  const handleSetGroupBy = useCallback((v: DashboardGroupBy) => {
    setDashGroupBy(v);
    writeLs(LS_GROUP_BY_KEY, v);
  }, []);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
              to="/agents"
              description={
                <span>
                  {data.agents.running} running{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart runs={runs ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart runs={runs ?? []} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Activity
                </h3>
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Recent Tasks
                </h3>
                <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
                  <button
                    type="button"
                    onClick={() => handleSetGroupBy("flat")}
                    className={cn(
                      "px-2.5 py-1 transition-colors",
                      dashGroupBy === "flat"
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    Flat
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetGroupBy("grouped")}
                    className={cn(
                      "px-2.5 py-1 transition-colors border-l border-border",
                      dashGroupBy === "grouped"
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    By assignee
                  </button>
                </div>
              </div>

              {recentIssues.length === 0 ? (
                <div className="border border-border p-4">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </div>
              ) : dashGroupBy === "flat" ? (
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <IssueRow key={issue.id} issue={issue} agentName={agentName} />
                  ))}
                </div>
              ) : (
                <div className="border border-border overflow-hidden divide-y divide-border">
                  {issueGroups.map((group) => {
                    const isOpen = openGroups[group.key] ?? true;
                    return (
                      <div key={group.key}>
                        <IssueGroupHeader
                          label={group.label}
                          collapsible
                          collapsed={!isOpen}
                          onToggle={() => toggleGroup(group.key)}
                          trailing={
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground font-normal normal-case tracking-normal">
                                {group.issues.length}
                              </span>
                              <StatusBreakdown counts={group.statusCounts} />
                            </div>
                          }
                          className="bg-muted/30 px-3"
                        />
                        {isOpen && (
                          <div className="divide-y divide-border">
                            {group.issues.map((issue) => (
                              <IssueRow key={issue.id} issue={issue} agentName={agentName} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}

function IssueRow({
  issue,
  agentName,
}: {
  issue: Issue;
  agentName: (id: string | null) => string | null;
}) {
  return (
    <Link
      key={issue.id}
      to={`/issues/${issue.identifier ?? issue.id}`}
      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
    >
      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
        {/* Status icon - left column on mobile */}
        <span className="shrink-0 sm:hidden">
          <StatusIcon status={issue.status} />
        </span>

        {/* Right column on mobile: title + metadata stacked */}
        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
            {issue.title}
          </span>
          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} /></span>
            <span className="text-xs font-mono text-muted-foreground">
              {issue.identifier ?? issue.id.slice(0, 8)}
            </span>
            {issue.assigneeAgentId && (() => {
              const name = agentName(issue.assigneeAgentId);
              return name
                ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                : null;
            })()}
            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
              {timeAgo(issue.updatedAt)}
            </span>
          </span>
        </span>
      </div>
    </Link>
  );
}
