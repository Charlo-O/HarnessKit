import { CheckCircle2, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KindBadge } from "@/components/shared/kind-badge";
import { humanizeError } from "@/lib/errors";
import { api } from "@/lib/invoke";
import type {
  AgentSyncSummary,
  Extension,
  ExtensionKind,
  GroupedExtension,
} from "@/lib/types";
import { agentDisplayName, sortAgents } from "@/lib/types";
import { useAgentStore } from "@/stores/agent-store";
import { buildGroups, useExtensionStore } from "@/stores/extension-store";
import { toast } from "@/stores/toast-store";

type SyncKind = Extract<ExtensionKind, "skill" | "mcp" | "plugin">;

const SYNC_KINDS: SyncKind[] = ["skill", "mcp", "plugin"];

function isSyncKind(kind: ExtensionKind): kind is SyncKind {
  return (SYNC_KINDS as readonly ExtensionKind[]).includes(kind);
}

function chooseSourceInstance(group: GroupedExtension): Extension {
  return (
    group.instances.find(
      (instance) => instance.enabled && instance.source_path,
    ) ??
    group.instances.find((instance) => instance.enabled) ??
    group.instances.find((instance) => instance.source_path) ??
    group.instances[0]
  );
}

function toggleSetValue<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function AgentSyncPanel() {
  const { t } = useTranslation("extensions");
  const extensions = useExtensionStore((s) => s.extensions);
  const fetchExtensions = useExtensionStore((s) => s.fetch);
  const agents = useAgentStore((s) => s.agents);
  const agentOrder = useAgentStore((s) => s.agentOrder);
  const fetchAgents = useAgentStore((s) => s.fetch);

  const [selectedKinds, setSelectedKinds] = useState<Set<SyncKind>>(
    () => new Set(SYNC_KINDS),
  );
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedItems, setSelectedItems] = useState<Set<string>>(
    () => new Set(),
  );
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AgentSyncSummary | null>(null);
  const initializedTargets = useRef(false);
  const initializedItems = useRef(false);

  useEffect(() => {
    if (extensions.length === 0) {
      fetchExtensions();
    }
  }, [extensions.length, fetchExtensions]);

  useEffect(() => {
    if (agents.length === 0) {
      fetchAgents();
    }
  }, [agents.length, fetchAgents]);

  const targetAgents = useMemo(
    () =>
      sortAgents(
        agents.filter((agent) => agent.detected && agent.enabled),
        agentOrder,
      ),
    [agents, agentOrder],
  );

  const syncableGroups = useMemo(
    () =>
      buildGroups(extensions)
        .filter((group) => isSyncKind(group.kind))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [extensions],
  );

  useEffect(() => {
    if (initializedTargets.current || targetAgents.length === 0) return;
    setSelectedTargets(new Set(targetAgents.map((agent) => agent.name)));
    initializedTargets.current = true;
  }, [targetAgents]);

  useEffect(() => {
    if (initializedItems.current || syncableGroups.length === 0) return;
    setSelectedItems(new Set(syncableGroups.map((group) => group.groupKey)));
    initializedItems.current = true;
  }, [syncableGroups]);

  const visibleGroups = useMemo(
    () =>
      syncableGroups.filter(
        (group) => isSyncKind(group.kind) && selectedKinds.has(group.kind),
      ),
    [syncableGroups, selectedKinds],
  );

  const selectedTargetNames = useMemo(
    () =>
      targetAgents
        .filter((agent) => selectedTargets.has(agent.name))
        .map((agent) => agent.name),
    [targetAgents, selectedTargets],
  );

  const plannedItems = useMemo(
    () =>
      visibleGroups
        .filter((group) => selectedItems.has(group.groupKey))
        .map((group) => ({
          group,
          source: chooseSourceInstance(group),
          targetAgents: selectedTargetNames.filter(
            (agent) => !group.agents.includes(agent),
          ),
        }))
        .filter((item) => item.targetAgents.length > 0),
    [visibleGroups, selectedItems, selectedTargetNames],
  );

  const plannedCount = plannedItems.reduce(
    (count, item) => count + item.targetAgents.length,
    0,
  );

  const failedResults =
    summary?.results.filter((result) => result.status === "failed") ?? [];

  const handleSelectVisible = () => {
    setSelectedItems((current) => {
      const next = new Set(current);
      for (const group of visibleGroups) next.add(group.groupKey);
      return next;
    });
  };

  const handleClearVisible = () => {
    setSelectedItems((current) => {
      const next = new Set(current);
      for (const group of visibleGroups) next.delete(group.groupKey);
      return next;
    });
  };

  const handleSync = async () => {
    if (plannedItems.length === 0) return;
    setSyncing(true);
    setError(null);
    setSummary(null);
    try {
      const result = await api.syncToAgents(
        plannedItems.map((item) => ({
          extension_id: item.source.id,
          target_agents: item.targetAgents,
        })),
      );
      setSummary(result);
      await fetchExtensions();
      await fetchAgents();
      if (result.failed > 0) {
        toast.error(
          t("agentSync.toastPartial", {
            deployed: result.deployed,
            failed: result.failed,
          }),
        );
      } else {
        toast.success(
          t("agentSync.toastSuccess", { deployed: result.deployed }),
        );
      }
    } catch (e) {
      const message = humanizeError(e);
      setError(message);
      toast.error(message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <RefreshCw size={14} />
            {t("agentSync.title")}
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            {t("agentSync.desc")}
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing || plannedCount === 0}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {syncing ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              {t("agentSync.syncing")}
            </>
          ) : (
            <>
              <RotateCcw size={12} />
              {t("agentSync.syncNow", { count: plannedCount })}
            </>
          )}
        </button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("agentSync.items", {
                selected: visibleGroups.filter((group) =>
                  selectedItems.has(group.groupKey),
                ).length,
                total: visibleGroups.length,
              })}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSelectVisible}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t("agentSync.selectAll")}
              </button>
              <button
                onClick={handleClearVisible}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t("agentSync.clear")}
              </button>
            </div>
          </div>

          <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
            {visibleGroups.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("agentSync.noItems")}
              </div>
            ) : (
              visibleGroups.map((group) => {
                const checked = selectedItems.has(group.groupKey);
                const missingTargets = selectedTargetNames.filter(
                  (agent) => !group.agents.includes(agent),
                );
                return (
                  <label
                    key={group.groupKey}
                    className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 border-border border-b p-3 last:border-b-0 hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedItems((current) =>
                          toggleSetValue(current, group.groupKey),
                        )
                      }
                      className="mt-1 rounded border-border accent-primary"
                    />
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {group.name}
                        </span>
                        <KindBadge kind={group.kind} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {group.agents.map((agent) => (
                          <span
                            key={agent}
                            className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {agentDisplayName(agent)}
                          </span>
                        ))}
                        {missingTargets.length > 0 && checked && (
                          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                            {t("agentSync.pendingTargets", {
                              count: missingTargets.length,
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        </div>

        <aside className="space-y-4 lg:border-border lg:border-l lg:pl-4">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t("agentSync.include")}
            </p>
            <div className="space-y-2">
              {SYNC_KINDS.map((kind) => (
                <label
                  key={kind}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span>{t(`agentSync.kinds.${kind}`)}</span>
                  <input
                    type="checkbox"
                    checked={selectedKinds.has(kind)}
                    onChange={() =>
                      setSelectedKinds((current) =>
                        toggleSetValue(current, kind),
                      )
                    }
                    className="rounded border-border accent-primary"
                  />
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t("agentSync.targets")}
            </p>
            <div className="space-y-2">
              {targetAgents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("agentSync.noTargets")}
                </p>
              ) : (
                targetAgents.map((agent) => (
                  <label
                    key={agent.name}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="truncate">
                      {agentDisplayName(agent.name)}
                    </span>
                    <input
                      type="checkbox"
                      checked={selectedTargets.has(agent.name)}
                      onChange={() =>
                        setSelectedTargets((current) =>
                          toggleSetValue(current, agent.name),
                        )
                      }
                      className="rounded border-border accent-primary"
                    />
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg bg-muted p-3 text-xs">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 size={13} />
              {plannedCount > 0
                ? t("agentSync.ready", { count: plannedCount })
                : t("agentSync.noPending")}
            </div>
            {summary && (
              <p className="mt-2 text-muted-foreground">
                {t("agentSync.summary", {
                  deployed: summary.deployed,
                  skipped: summary.skipped,
                  failed: summary.failed,
                })}
              </p>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          {failedResults.length > 0 && (
            <div className="space-y-1 text-xs">
              <p className="font-medium text-destructive">
                {t("agentSync.failedTitle")}
              </p>
              {failedResults.slice(0, 4).map((result) => (
                <p
                  key={`${result.extension_id}-${result.target_agent}`}
                  className="text-muted-foreground"
                >
                  {result.extension_name} {"->"}{" "}
                  {agentDisplayName(result.target_agent)}: {result.message}
                </p>
              ))}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
