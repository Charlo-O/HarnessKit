import {
  Archive,
  CheckCircle2,
  Copy,
  FolderOpen,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Tag,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { humanizeError } from "@/lib/errors";
import { api } from "@/lib/invoke";
import type {
  AgentSessionEntry,
  AgentSessionInfo,
  AgentSessionRoot,
  AgentSessionSyncSummary,
} from "@/lib/types";
import { agentDisplayName, sortAgents } from "@/lib/types";
import { useAgentStore } from "@/stores/agent-store";
import { toast } from "@/stores/toast-store";

interface SessionRowItem {
  key: string;
  agent: string;
  root: AgentSessionRoot;
  session: AgentSessionEntry;
}

interface SessionDirectoryInfo {
  key: string;
  label: string;
  path: string;
  relativeDir: string;
}

interface SessionDirectoryGroup extends SessionDirectoryInfo {
  agent: string;
  root: AgentSessionRoot;
  rows: SessionRowItem[];
}

type SessionView = "recent" | "projects" | "inbox" | "favorites" | "archived";
type SessionStatus = "inbox" | "active" | "valuable" | "archived";

interface SessionOrganizationMeta {
  favorite: boolean;
  status: SessionStatus;
  tags: string[];
  updatedAt: string;
}

type SessionOrganizationMap = Record<string, SessionOrganizationMeta>;
type SessionMetaUpdater = (
  current: SessionOrganizationMeta,
) => SessionOrganizationMeta;

const SESSION_ORGANIZATION_STORAGE_KEY = "harnesskit.sessionOrganization.v1";
const SESSION_VIEWS: SessionView[] = [
  "recent",
  "projects",
  "inbox",
  "favorites",
  "archived",
];
const SESSION_STATUSES: SessionStatus[] = [
  "inbox",
  "active",
  "valuable",
  "archived",
];

function defaultSessionMeta(): SessionOrganizationMeta {
  return {
    favorite: false,
    status: "inbox",
    tags: [],
    updatedAt: "",
  };
}

function normalizeSessionTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = tag.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
    if (normalized.length >= 12) break;
  }
  return normalized;
}

function normalizeSessionMeta(value: unknown): SessionOrganizationMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = SESSION_STATUSES.includes(record.status as SessionStatus)
    ? (record.status as SessionStatus)
    : "inbox";
  const tags = Array.isArray(record.tags)
    ? normalizeSessionTags(
        record.tags.filter((tag): tag is string => typeof tag === "string"),
      )
    : [];
  return {
    favorite: record.favorite === true,
    status,
    tags,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

function loadSessionOrganization(): SessionOrganizationMap {
  if (typeof window === "undefined") return {};
  try {
    const storage = window.localStorage;
    if (!storage) return {};
    const raw = storage.getItem(SESSION_ORGANIZATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed).flatMap(([key, value]) => {
      const meta = normalizeSessionMeta(value);
      return meta ? [[key, meta] as const] : [];
    });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function saveSessionOrganization(organization: SessionOrganizationMap) {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    if (!storage) return;
    storage.setItem(
      SESSION_ORGANIZATION_STORAGE_KEY,
      JSON.stringify(organization),
    );
  } catch {
    return;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatModified(value: string | null): string {
  if (!value) return "--";
  return new Date(value).toLocaleString();
}

function joinSessionPath(rootPath: string, relativeDir: string): string {
  if (!relativeDir) return rootPath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const suffix = relativeDir.replaceAll("/", separator);
  return `${rootPath}${rootPath.endsWith(separator) ? "" : separator}${suffix}`;
}

function sessionDirectory(item: SessionRowItem): SessionDirectoryInfo {
  const parts = item.session.relative_path.split("/").filter(Boolean);
  parts.pop();
  const relativeDir = parts.join("/");
  const tail = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return {
    key: `${item.agent}:${item.root.id}:${relativeDir || "."}`,
    label: tail ? `${item.root.label} / ${tail}` : item.root.label,
    path: joinSessionPath(item.root.path, relativeDir),
    relativeDir,
  };
}

function sessionOrganizationKey(item: SessionRowItem): string {
  return item.session.path || item.key;
}

function getSessionMeta(
  organization: SessionOrganizationMap,
  item: SessionRowItem,
): SessionOrganizationMeta {
  return organization[sessionOrganizationKey(item)] ?? defaultSessionMeta();
}

function sessionModifiedTime(item: SessionRowItem): number {
  if (!item.session.modified_at) return 0;
  return new Date(item.session.modified_at).getTime() || 0;
}

export function SessionSyncPanel() {
  const { t } = useTranslation("extensions");
  const { t: tc } = useTranslation("common");
  const agents = useAgentStore((s) => s.agents);
  const agentOrder = useAgentStore((s) => s.agentOrder);
  const fetchAgents = useAgentStore((s) => s.fetch);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AgentSessionSyncSummary | null>(null);
  const [view, setView] = useState<SessionView>("recent");
  const [organization, setOrganization] = useState<SessionOrganizationMap>(() =>
    loadSessionOrganization(),
  );

  const detectedSessions = useMemo(() => {
    const enabled = new Set(
      agents
        .filter((agent) => agent.detected && agent.enabled)
        .map((agent) => agent.name),
    );
    const visible = sessions.filter(
      (session) => session.detected && enabled.has(session.agent),
    );
    return sortAgents(
      visible.map((session) => ({ ...session, name: session.agent })),
      agentOrder,
    ).map(({ name: _name, ...session }) => session);
  }, [agents, agentOrder, sessions]);

  const sourceOptions = useMemo(
    () => detectedSessions.map((session) => session.agent),
    [detectedSessions],
  );

  const rows = useMemo<SessionRowItem[]>(
    () =>
      detectedSessions.flatMap((session) =>
        session.roots.flatMap((root) =>
          (root.sessions ?? []).map((sessionEntry) => ({
            key: `${session.agent}:${root.id}:${sessionEntry.id}`,
            agent: session.agent,
            root,
            session: sessionEntry,
          })),
        ),
      ),
    [detectedSessions],
  );

  const viewCounts = useMemo<Record<SessionView, number>>(() => {
    const counts: Record<SessionView, number> = {
      recent: 0,
      projects: 0,
      inbox: 0,
      favorites: 0,
      archived: 0,
    };
    for (const item of rows) {
      const meta = getSessionMeta(organization, item);
      const archived = meta.status === "archived";
      if (!archived) {
        counts.recent += 1;
        counts.projects += 1;
      }
      if (meta.status === "inbox") counts.inbox += 1;
      if (meta.favorite && !archived) counts.favorites += 1;
      if (archived) counts.archived += 1;
    }
    return counts;
  }, [organization, rows]);

  const viewRows = useMemo(() => {
    const filtered = rows.filter((item) => {
      const meta = getSessionMeta(organization, item);
      switch (view) {
        case "projects":
          return meta.status !== "archived";
        case "inbox":
          return meta.status === "inbox";
        case "favorites":
          return meta.favorite && meta.status !== "archived";
        case "archived":
          return meta.status === "archived";
        default:
          return meta.status !== "archived";
      }
    });
    if (view === "projects") return filtered;
    return [...filtered].sort(
      (left, right) => sessionModifiedTime(right) - sessionModifiedTime(left),
    );
  }, [organization, rows, view]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return viewRows.filter((item) => {
      if (sourceFilter && item.agent !== sourceFilter) return false;
      const meta = getSessionMeta(organization, item);
      if (!query) return true;
      const directory = sessionDirectory(item);
      return [
        agentDisplayName(item.agent),
        item.agent,
        t(`sessionSync.statusOptions.${meta.status}`),
        meta.status,
        ...meta.tags,
        item.session.summary,
        item.session.file_name,
        item.session.relative_path,
        item.session.path,
        directory.label,
        directory.path,
        directory.relativeDir,
        item.root.label,
        item.root.path,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [organization, searchQuery, sourceFilter, t, viewRows]);

  const filteredGroups = useMemo<SessionDirectoryGroup[]>(() => {
    const groups = new Map<string, SessionDirectoryGroup>();
    for (const item of filteredRows) {
      const directory = sessionDirectory(item);
      const existing = groups.get(directory.key);
      if (existing) {
        existing.rows.push(item);
        continue;
      }
      groups.set(directory.key, {
        ...directory,
        agent: item.agent,
        root: item.root,
        rows: [item],
      });
    }
    return Array.from(groups.values());
  }, [filteredRows]);

  const selectedItem = rows.find((item) => item.key === selectedKey) ?? null;
  const selectedMeta = selectedItem
    ? getSessionMeta(organization, selectedItem)
    : null;
  const targetSessions = useMemo(
    () =>
      selectedItem
        ? detectedSessions.filter(
            (session) => session.agent !== selectedItem.agent,
          )
        : [],
    [detectedSessions, selectedItem],
  );
  const targetAgents = useMemo(
    () => targetSessions.map((session) => session.agent),
    [targetSessions],
  );
  const targetAgentsKey = targetAgents.join("\u0000");
  const selectedTargetAgents = targetAgents.filter((agent) =>
    selectedTargets.has(agent),
  );
  const failedResults =
    summary?.results.filter((result) => result.status === "failed") ?? [];

  const updateSessionMeta = useCallback(
    (item: SessionRowItem, updater: SessionMetaUpdater) => {
      const key = sessionOrganizationKey(item);
      setOrganization((current) => {
        const next = updater(getSessionMeta(current, item));
        return {
          ...current,
          [key]: {
            ...next,
            tags: normalizeSessionTags(next.tags),
            updatedAt: new Date().toISOString(),
          },
        };
      });
    },
    [],
  );

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listAgentSessions();
      setSessions(result);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (agents.length === 0) {
      fetchAgents();
    }
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    saveSessionOrganization(organization);
  }, [organization]);

  useEffect(() => {
    if (!selectedKey) return;
    if (!rows.some((item) => item.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [rows, selectedKey]);

  useEffect(() => {
    if (!sourceFilter || sourceOptions.includes(sourceFilter)) return;
    setSourceFilter("");
  }, [sourceFilter, sourceOptions]);

  useEffect(() => {
    if (!selectedKey) return;
    if (!filteredRows.some((item) => item.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [filteredRows, selectedKey]);

  useEffect(() => {
    setSelectedTargets(
      new Set(targetAgentsKey ? targetAgentsKey.split("\u0000") : []),
    );
    setSummary(null);
  }, [targetAgentsKey]);

  const canCopy = !!selectedItem && selectedTargetAgents.length > 0 && !copying;

  const handleCopy = async () => {
    if (!selectedItem || selectedTargetAgents.length === 0) return;
    setCopying(true);
    setError(null);
    setSummary(null);
    try {
      const result = await api.syncAgentSessions(
        selectedItem.agent,
        selectedItem.root.id,
        selectedTargetAgents,
        selectedItem.session.path,
      );
      setSummary(result);
      await fetchSessions();
      if (result.failed > 0) {
        toast.error(
          t("sessionSync.toastPartial", {
            copied: result.copied,
            failed: result.failed,
          }),
        );
      } else {
        toast.success(t("sessionSync.toastSuccess", { copied: result.copied }));
      }
    } catch (e) {
      const message = humanizeError(e);
      setError(message);
      toast.error(message);
    } finally {
      setCopying(false);
    }
  };

  const toggleTarget = (agent: string) => {
    setSelectedTargets((current) => {
      const next = new Set(current);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  };

  const selectRow = (key: string) => {
    setSelectedKey((current) => {
      const next = current === key ? null : key;
      if (next !== current) {
        setSummary(null);
        setError(null);
      }
      return next;
    });
  };

  const hasFilters = !!(
    sourceFilter ||
    searchQuery ||
    searchDraft ||
    view !== "recent"
  );

  const handleSearch = () => {
    setSearchQuery(searchDraft.trim());
  };

  const clearFilters = () => {
    setSourceFilter("");
    setSearchDraft("");
    setSearchQuery("");
    setView("recent");
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div
        className={
          selectedItem
            ? "absolute inset-0 overflow-y-auto pb-4 lg:right-[25rem] lg:pr-4"
            : "absolute inset-0 overflow-y-auto pb-4"
        }
      >
        <div className="sticky top-0 z-20 -mx-1 mb-3 flex flex-wrap items-center gap-2 border-border/70 border-b bg-background/95 px-1 py-2 backdrop-blur">
          <fieldset className="flex shrink-0 flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1">
            <legend className="sr-only">{t("sessionSync.viewAria")}</legend>
            {SESSION_VIEWS.map((viewOption) => {
              const active = view === viewOption;
              return (
                <button
                  key={viewOption}
                  type="button"
                  onClick={() => setView(viewOption)}
                  aria-pressed={active}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span>{t(`sessionSync.views.${viewOption}`)}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                    {viewCounts[viewOption]}
                  </span>
                </button>
              );
            })}
          </fieldset>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("filters.resultCount", { count: filteredRows.length })}
          </span>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="shrink-0 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t("filters.clearFilters")}
            </button>
          )}
          <div className="flex-1" />
          {sourceOptions.length > 0 && (
            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              aria-label={t("filters.filterBySource")}
              className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors focus:border-ring focus:outline-none"
            >
              <option value="">{t("filters.allSources")}</option>
              {sourceOptions.map((agent) => (
                <option key={agent} value={agent}>
                  {agentDisplayName(agent)}
                </option>
              ))}
            </select>
          )}
          <div className="relative w-52 shrink-0">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSearch();
              }}
              placeholder={t("sessionSync.searchPlaceholder")}
              title={t("sessionSync.searchTitle")}
              aria-label={t("sessionSync.searchAria")}
              className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-8 text-xs placeholder:text-muted-foreground focus:border-ring focus:outline-none"
            />
            {searchDraft && (
              <button
                onClick={() => {
                  setSearchDraft("");
                  setSearchQuery("");
                }}
                aria-label={t("filters.clearSearch")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button
            onClick={handleSearch}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
          >
            <Search size={12} />
            {tc("actions.search")}
          </button>
          <button
            onClick={fetchSessions}
            disabled={loading || copying}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label={t("sessionSync.refresh")}
            title={t("sessionSync.refresh")}
          >
            <RefreshCw
              size={13}
              className={loading ? "origin-center animate-spin" : ""}
            />
          </button>
        </div>

        <div className="rounded-xl border border-border overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table
              className="w-full table-fixed"
              aria-label={t("sessionSync.tableAria")}
            >
              <colgroup>
                <col className="w-[12%]" />
                <col className="w-[34%]" />
                <col className="w-[24%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead className="bg-muted/30">
                <tr>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {t("sessionSync.headers.agent")}
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {t("sessionSync.headers.summary")}
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {t("sessionSync.headers.directory")}
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {t("sessionSync.headers.size")}
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {t("sessionSync.headers.modified")}
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {t("sessionSync.headers.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredGroups.map((group) => {
                  const groupAgent = agentDisplayName(group.agent);
                  return (
                    <Fragment key={group.key}>
                      <tr className="bg-muted/35">
                        <td className="px-4 py-2 text-xs font-semibold text-foreground">
                          {groupAgent}
                        </td>
                        <td colSpan={5} className="px-4 py-2">
                          <div className="flex min-w-0 items-center gap-2 text-xs">
                            <span className="shrink-0 font-medium text-foreground">
                              {group.label}
                            </span>
                            <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border">
                              {t("sessionSync.groupSessions", {
                                count: group.rows.length,
                              })}
                            </span>
                            <span className="truncate text-[10px] text-muted-foreground">
                              {group.path}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {group.rows.map((item) => {
                        const selected = item.key === selectedKey;
                        const directory = sessionDirectory(item);
                        const meta = getSessionMeta(organization, item);
                        return (
                          <tr
                            key={item.key}
                            tabIndex={0}
                            aria-selected={selected}
                            onClick={() => selectRow(item.key)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                selectRow(item.key);
                              }
                            }}
                            className={`cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                              selected ? "bg-accent" : "hover:bg-muted/40"
                            }`}
                          >
                            <td className="px-4 py-3 text-sm font-medium whitespace-nowrap">
                              {groupAgent}
                            </td>
                            <td className="px-4 py-3 text-sm">
                              <p className="line-clamp-2 font-medium">
                                {item.session.summary}
                              </p>
                              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span className="truncate">
                                  {item.session.file_name}
                                </span>
                                <span className="rounded-full bg-muted px-1.5 py-0.5">
                                  {t(
                                    `sessionSync.statusOptions.${meta.status}`,
                                  )}
                                </span>
                                {meta.favorite && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
                                    <Star size={10} fill="currentColor" />
                                    {t("sessionSync.favorite")}
                                  </span>
                                )}
                                {meta.tags.slice(0, 2).map((tag) => (
                                  <span
                                    key={tag}
                                    className="inline-flex max-w-24 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5"
                                  >
                                    <Tag size={10} />
                                    <span className="truncate">{tag}</span>
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-sm">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate font-medium">
                                    {directory.label}
                                  </span>
                                  {!item.root.exists && (
                                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                      {t("sessionSync.missing")}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 truncate text-[10px] text-muted-foreground">
                                  {directory.path}
                                </p>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                              {formatBytes(item.session.total_bytes)}
                            </td>
                            <td className="px-4 py-3 text-sm text-muted-foreground">
                              {formatModified(item.session.modified_at)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex justify-end gap-1">
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    updateSessionMeta(item, (current) => ({
                                      ...current,
                                      favorite: !current.favorite,
                                    }));
                                  }}
                                  className={`inline-flex size-8 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground disabled:opacity-40 ${
                                    meta.favorite
                                      ? "text-primary"
                                      : "text-muted-foreground"
                                  }`}
                                  aria-label={
                                    meta.favorite
                                      ? t("sessionSync.unfavorite")
                                      : t("sessionSync.favorite")
                                  }
                                  aria-pressed={meta.favorite}
                                  title={
                                    meta.favorite
                                      ? t("sessionSync.unfavorite")
                                      : t("sessionSync.favorite")
                                  }
                                >
                                  <Star
                                    size={13}
                                    fill={
                                      meta.favorite ? "currentColor" : "none"
                                    }
                                  />
                                </button>
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    api.revealInFileManager(item.session.path);
                                  }}
                                  className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                                  aria-label={t("sessionSync.openSession", {
                                    label: item.session.summary,
                                  })}
                                  title={t("sessionSync.open")}
                                >
                                  <FolderOpen size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredRows.length === 0 && (
            <div className="py-12 px-6 text-left">
              <h4 className="text-sm font-medium text-foreground">
                {loading
                  ? t("sessionSync.loading")
                  : hasFilters
                    ? t("sessionSync.noFilterMatch")
                    : t("sessionSync.noSessions")}
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasFilters
                  ? t("sessionSync.noFilterHint")
                  : t("sessionSync.emptyHint")}
              </p>
            </div>
          )}
        </div>
      </div>

      {selectedItem && (
        <SessionDetail
          canCopy={canCopy}
          copying={copying}
          error={error}
          failedResults={failedResults}
          item={selectedItem}
          meta={selectedMeta ?? defaultSessionMeta()}
          onClose={() => setSelectedKey(null)}
          onCopy={handleCopy}
          onToggleTarget={toggleTarget}
          onUpdateMeta={updateSessionMeta}
          selectedTargetAgents={selectedTargetAgents}
          selectedTargets={selectedTargets}
          summary={summary}
          targetSessions={targetSessions}
        />
      )}
    </div>
  );
}

function SessionDetail({
  canCopy,
  copying,
  error,
  failedResults,
  item,
  meta,
  onClose,
  onCopy,
  onToggleTarget,
  onUpdateMeta,
  selectedTargetAgents,
  selectedTargets,
  summary,
  targetSessions,
}: {
  canCopy: boolean;
  copying: boolean;
  error: string | null;
  failedResults: AgentSessionSyncSummary["results"];
  item: SessionRowItem;
  meta: SessionOrganizationMeta;
  onClose: () => void;
  onCopy: () => void;
  onToggleTarget: (agent: string) => void;
  onUpdateMeta: (item: SessionRowItem, updater: SessionMetaUpdater) => void;
  selectedTargetAgents: string[];
  selectedTargets: Set<string>;
  summary: AgentSessionSyncSummary | null;
  targetSessions: AgentSessionInfo[];
}) {
  const { t } = useTranslation("extensions");
  const { t: tc } = useTranslation("common");
  const directory = sessionDirectory(item);
  const [tagDraft, setTagDraft] = useState("");

  useEffect(() => {
    if (item.key) setTagDraft("");
  }, [item.key]);

  const handleAddTag = () => {
    const tag = tagDraft.trim();
    if (!tag) return;
    onUpdateMeta(item, (current) => ({
      ...current,
      tags: normalizeSessionTags([...current.tags, tag]),
    }));
    setTagDraft("");
  };

  return (
    <aside
      onWheel={(event) => event.stopPropagation()}
      className="absolute right-0 top-0 bottom-0 z-10 flex w-96 flex-col rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-border border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MessageSquareText size={15} className="text-muted-foreground" />
            <h3 className="truncate text-sm font-semibold">
              {item.session.summary}
            </h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {agentDisplayName(item.agent)} / {directory.label}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={tc("actions.close")}
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {t("sessionSync.headers.path")}
            </p>
            <p className="mt-1 break-all rounded-lg bg-muted px-3 py-2 text-xs">
              {item.session.path}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {t("sessionSync.headers.directory")}
            </p>
            <p className="mt-1 break-all rounded-lg bg-muted px-3 py-2 text-xs">
              {directory.path}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg bg-muted px-3 py-2">
              <p className="text-muted-foreground">
                {t("sessionSync.headers.file")}
              </p>
              <p className="mt-1 truncate font-medium">
                {item.session.file_name}
              </p>
            </div>
            <div className="rounded-lg bg-muted px-3 py-2">
              <p className="text-muted-foreground">
                {t("sessionSync.headers.size")}
              </p>
              <p className="mt-1 font-medium">
                {formatBytes(item.session.total_bytes)}
              </p>
            </div>
            <div className="rounded-lg bg-muted px-3 py-2">
              <p className="text-muted-foreground">
                {t("sessionSync.headers.modified")}
              </p>
              <p className="mt-1 font-medium">
                {formatModified(item.session.modified_at)}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t("sessionSync.organize")}
            </p>
            <button
              onClick={() =>
                onUpdateMeta(item, (current) => ({
                  ...current,
                  favorite: !current.favorite,
                }))
              }
              aria-pressed={meta.favorite}
              className={`inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted ${
                meta.favorite
                  ? "bg-primary/10 text-primary"
                  : "bg-card text-foreground"
              }`}
            >
              <Star size={12} fill={meta.favorite ? "currentColor" : "none"} />
              {meta.favorite
                ? t("sessionSync.unfavorite")
                : t("sessionSync.favorite")}
            </button>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select
              value={meta.status}
              onChange={(event) =>
                onUpdateMeta(item, (current) => ({
                  ...current,
                  status: event.target.value as SessionStatus,
                }))
              }
              aria-label={t("sessionSync.statusAria")}
              className="min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground focus:border-ring focus:outline-none"
            >
              {SESSION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`sessionSync.statusOptions.${status}`)}
                </option>
              ))}
            </select>
            <button
              onClick={() =>
                onUpdateMeta(item, (current) => ({
                  ...current,
                  status: current.status === "archived" ? "inbox" : "archived",
                }))
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-2 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
            >
              {meta.status === "archived" ? (
                <RotateCcw size={12} />
              ) : (
                <Archive size={12} />
              )}
              {meta.status === "archived"
                ? t("sessionSync.unarchive")
                : t("sessionSync.archive")}
            </button>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Tag size={12} />
              {t("sessionSync.tags")}
            </div>
            {meta.tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("sessionSync.noTags")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {meta.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs"
                  >
                    <span className="truncate">{tag}</span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateMeta(item, (current) => ({
                          ...current,
                          tags: current.tags.filter((value) => value !== tag),
                        }))
                      }
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={t("sessionSync.removeTag", { tag })}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <input
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleAddTag();
                  }
                }}
                placeholder={t("sessionSync.tagPlaceholder")}
                className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-xs focus:border-ring focus:outline-none"
              />
              <button
                onClick={handleAddTag}
                disabled={!tagDraft.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-2 text-xs font-medium text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
              >
                <Plus size={12} />
                {t("sessionSync.addTag")}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("sessionSync.targets")}
          </p>
          <div className="space-y-2">
            {targetSessions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("sessionSync.noTargets")}
              </p>
            ) : (
              targetSessions.map((session) => (
                <label
                  key={session.agent}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/60"
                >
                  <span className="truncate">
                    {agentDisplayName(session.agent)}
                  </span>
                  <input
                    type="checkbox"
                    checked={selectedTargets.has(session.agent)}
                    onChange={() => onToggleTarget(session.agent)}
                    className="rounded border-border accent-primary"
                    disabled={copying}
                  />
                </label>
              ))
            )}
          </div>
        </div>

        <div className="mt-5 rounded-lg bg-muted p-3 text-xs">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 size={13} />
            {canCopy
              ? t("sessionSync.ready", {
                  count: selectedTargetAgents.length,
                })
              : t("sessionSync.notReady")}
          </div>
          {summary && (
            <p className="mt-2 text-muted-foreground">
              {t("sessionSync.summary", {
                copied: summary.copied,
                skipped: summary.skipped,
                failed: summary.failed,
              })}
            </p>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        {failedResults.length > 0 && (
          <div className="mt-3 space-y-1 text-xs">
            <p className="font-medium text-destructive">
              {t("sessionSync.failedTitle")}
            </p>
            {failedResults.slice(0, 4).map((result) => (
              <p
                key={`${result.source_agent}-${result.target_agent}`}
                className="text-muted-foreground"
              >
                {agentDisplayName(result.target_agent)}: {result.message}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-border border-t p-4">
        <button
          onClick={onCopy}
          disabled={!canCopy}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {copying ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Copy size={12} />
          )}
          {copying
            ? t("sessionSync.copying")
            : t("sessionSync.copy", { count: selectedTargetAgents.length })}
        </button>
      </div>
    </aside>
  );
}
