"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, relativeTime } from "./adminApi";
import PageHeading from "./PageHeading";
import MetricCard from "./MetricCard";
import { ErrorState } from "./DataState";
import ActivityOverviewChart from "./ActivityOverviewChart";
import RecentActivityFeed from "./RecentActivityFeed";
import AccountDistributionChart from "./AccountDistributionChart";
import TopStudyGroupsTable from "./TopStudyGroupsTable";
import MatchingPerformanceCard from "./MatchingPerformanceCard";
import RecentReportsTable from "./RecentReportsTable";
import {
  AlertTriangleIcon,
  CalendarIcon,
  LayersIcon,
  NetworkIcon,
  UsersIcon,
  UserCheckIcon,
  UserMinusIcon,
  InboxIcon,
} from "./AdminIcons";

export default function DashboardView() {
  const [range, setRange] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (nextRange) => {
    try {
      const result = await apiRequest(`admin/overview?range=${nextRange}`);
      setData(result);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await apiRequest(`admin/overview?range=${range}`);
        if (active) {
          setData(result);
          setError("");
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [range]);

  function changeRange(nextRange) {
    setLoading(true);
    setRange(nextRange);
  }

  function refresh() {
    setRefreshing(true);
    load(range);
  }

  const metrics = data?.metrics;

  if (!data && error) {
    return (
      <>
        <PageHeading title="Dashboard" subtitle="Platform overview and key statistics." />
        <ErrorState message={error} onRetry={refresh} />
      </>
    );
  }

  const metricCards = [
    { key: "students", label: "Total students", value: metrics?.totalStudents, icon: UsersIcon, tone: "blue", href: "/admin/users?role=STUDENT" },
    { key: "active", label: "Active accounts", value: metrics?.activeAccounts, icon: UserCheckIcon, tone: "green", href: "/admin/users?status=ACTIVE" },
    { key: "suspended", label: "Suspended accounts", value: metrics?.suspendedAccounts, icon: UserMinusIcon, tone: "red", href: "/admin/users?status=SUSPENDED" },
    { key: "groups", label: "Total study groups", value: metrics?.totalGroups, icon: NetworkIcon, tone: "violet", href: "/admin/groups" },
    { key: "activeGroups", label: "Active study groups", value: metrics?.activeGroups, icon: LayersIcon, tone: "teal", href: "/admin/groups?status=ACTIVE" },
    { key: "memberships", label: "Group memberships", value: metrics?.totalMemberships, icon: InboxIcon, tone: "blue" },
    { key: "reports", label: "Pending reports", value: metrics?.pendingReports, icon: AlertTriangleIcon, tone: "orange", href: "/admin/reports" },
    { key: "sessions", label: "Sessions this month", value: metrics?.sessionsThisMonth, icon: CalendarIcon, tone: "violet" },
  ];

  return (
    <>
      <PageHeading
        title="Dashboard"
        subtitle="Platform overview and key statistics."
        updatedAt={data ? relativeTime(data.generatedAt) : null}
        onRefresh={refresh}
        refreshing={refreshing}
      />

      {error && data && (
        <div className="admin-banner admin-banner-warn" role="alert">
          Showing the last loaded data. {error}
        </div>
      )}

      <div className="admin-metric-grid">
        {metricCards.map((card) => (
          <MetricCard
            key={card.key}
            label={card.label}
            value={loading && !data ? undefined : card.value}
            icon={card.icon}
            tone={card.tone}
            href={card.href}
            loading={loading && !data}
          />
        ))}
      </div>

      <div className="admin-grid admin-grid-analytics">
        <ActivityOverviewChart
          series={data?.activitySeries || { labels: [], registrations: [], groups: [], sessions: [] }}
          range={range}
          onRangeChange={changeRange}
          loading={loading && !data}
          error={null}
          onRetry={refresh}
        />
        <div className="admin-stack">
          <RecentActivityFeed items={data?.recentActivity || []} loading={loading && !data} />
          <AccountDistributionChart distribution={data?.accountDistribution} loading={loading && !data} />
        </div>
      </div>

      <div className="admin-grid admin-grid-detail">
        <TopStudyGroupsTable groups={data?.topGroups || []} loading={loading && !data} />
        <MatchingPerformanceCard matching={data?.matching} loading={loading && !data} />
        <RecentReportsTable reports={data?.recentReports || []} loading={loading && !data} />
      </div>
    </>
  );
}
