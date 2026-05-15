import { CloudDownload, CloudUpload, Loader2, RefreshCcw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedEllipsis } from "@/components/shared/animated-ellipsis";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { humanizeError } from "@/lib/errors";
import { api } from "@/lib/invoke";
import type { SyncConfig } from "@/lib/types";
import { useExtensionStore } from "@/stores/extension-store";
import { toast } from "@/stores/toast-store";

interface SyncDialogProps {
  open: boolean;
  onClose: () => void;
}

type Phase = "main" | "configure";

export function SyncDialog({ open, onClose }: SyncDialogProps) {
  const { t } = useTranslation("extensions");
  const { t: tc } = useTranslation("common");
  const [phase, setPhase] = useState<Phase>("main");
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState<"push" | "pull" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Config form state
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [syncSkills, setSyncSkills] = useState(true);
  const [syncMcp, setSyncMcp] = useState(false);
  const [syncHooks, setSyncHooks] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const fetch = useExtensionStore((s) => s.fetch);

  useFocusTrap(dialogRef, open);

  // Load config on open
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestResult(null);
    api.syncGetConfig().then((cfg) => {
      setConfig(cfg);
      if (cfg) {
        setRepoUrl(cfg.repo_url);
        setBranch(cfg.branch);
        setSyncSkills(cfg.sync_skills);
        setSyncMcp(cfg.sync_mcp);
        setSyncHooks(cfg.sync_hooks);
        // If config exists, show main view; otherwise show configure
        setPhase("main");
      } else {
        setPhase("configure");
      }
    });
    api.syncHasToken().then(setHasToken);
  }, [open]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setPhase("main");
      setError(null);
      setTestResult(null);
      setToken("");
    }
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const handleSaveConfig = async () => {
    if (!repoUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await api.syncSaveConfig({
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || "main",
        syncSkills,
        syncMcp,
        syncHooks,
        token: token || undefined,
      });
      const cfg = await api.syncGetConfig();
      setConfig(cfg);
      setHasToken(!!token || hasToken);
      setPhase("main");
      toast.success(t("sync.configSaved"));
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setLoading(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await api.syncTestConnection(
        repoUrl.trim(),
        token || "",
      );
      setTestResult(result);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  };

  const handlePush = async () => {
    setSyncing("push");
    setError(null);
    try {
      const summary = await api.syncPush();
      toast.success(summary.message);
      // Refresh config to update last_sync_at
      const cfg = await api.syncGetConfig();
      setConfig(cfg);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setSyncing(null);
    }
  };

  const handlePull = async () => {
    setSyncing("pull");
    setError(null);
    try {
      const summary = await api.syncPull();
      toast.success(summary.message);
      // Refresh extensions after pull
      await fetch();
      const cfg = await api.syncGetConfig();
      setConfig(cfg);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setSyncing(null);
    }
  };

  const isConfigured = !!config;
  const isSyncing = syncing !== null;

  return (
    <div
      className="grid transition-[grid-template-rows] duration-[250ms]"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
    >
      <div className="overflow-hidden">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          className="rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          {phase === "configure" ? (
            <>
              <h3 className="text-sm font-semibold">{t("sync.configTitle")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("sync.configDesc")}
              </p>

              {/* Repo URL */}
              <div className="mt-3 space-y-2">
                <label className="block text-xs text-muted-foreground">
                  {t("sync.repoUrl")}
                </label>
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/user/my-agent-config"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/50"
                  disabled={loading}
                />
              </div>

              {/* Branch */}
              <div className="mt-2 space-y-2">
                <label className="block text-xs text-muted-foreground">
                  {t("sync.branch")}
                </label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/50"
                  disabled={loading}
                />
              </div>

              {/* Token */}
              <div className="mt-2 space-y-2">
                <label className="block text-xs text-muted-foreground">
                  {t("sync.token")}
                  {hasToken && (
                    <span className="ml-2 text-primary text-[10px]">
                      ({t("sync.tokenSaved")})
                    </span>
                  )}
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={
                    hasToken
                      ? t("sync.tokenPlaceholderSaved")
                      : t("sync.tokenPlaceholder")
                  }
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/50"
                  disabled={loading}
                />
              </div>

              {/* Scope checkboxes */}
              <div className="mt-3 space-y-1.5">
                <span className="text-xs text-muted-foreground">
                  {t("sync.include")}
                </span>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={syncSkills}
                      onChange={(e) => setSyncSkills(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    Skills
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={syncMcp}
                      onChange={(e) => setSyncMcp(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    MCP
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={syncHooks}
                      onChange={(e) => setSyncHooks(e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    Hooks
                  </label>
                </div>
              </div>

              {testResult && (
                <p className="mt-2 text-xs text-primary">{testResult}</p>
              )}
              {error && (
                <p className="mt-2 text-xs text-destructive">{error}</p>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handleTestConnection}
                  disabled={loading || !repoUrl.trim()}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : t("sync.testConnection")}
                </button>
                <button
                  onClick={handleSaveConfig}
                  disabled={loading || !repoUrl.trim()}
                  className="rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {t("sync.save")}
                </button>
                <button
                  onClick={onClose}
                  disabled={loading}
                  className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {tc("actions.cancel")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <RefreshCcw size={14} />
                  {t("sync.title")}
                </h3>
                <button
                  onClick={() => setPhase("configure")}
                  className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                  title={t("sync.configure")}
                >
                  <Settings2 size={14} />
                </button>
              </div>

              {config && (
                <p className="mt-1 text-xs text-muted-foreground truncate">
                  {config.repo_url} · {config.branch}
                </p>
              )}

              {config?.last_sync_at && (
                <p className="mt-1 text-[10px] text-muted-foreground/60">
                  {t("sync.lastSync")}: {new Date(config.last_sync_at).toLocaleString()}
                </p>
              )}

              {error && (
                <p className="mt-2 text-xs text-destructive">{error}</p>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handlePull}
                  disabled={!isConfigured || isSyncing}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {syncing === "pull" ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      {t("sync.pulling")}
                      <AnimatedEllipsis />
                    </>
                  ) : (
                    <>
                      <CloudDownload size={12} />
                      {t("sync.pull")}
                    </>
                  )}
                </button>
                <button
                  onClick={handlePush}
                  disabled={!isConfigured || isSyncing}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {syncing === "push" ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      {t("sync.pushing")}
                      <AnimatedEllipsis />
                    </>
                  ) : (
                    <>
                      <CloudUpload size={12} />
                      {t("sync.push")}
                    </>
                  )}
                </button>
                <button
                  onClick={onClose}
                  disabled={isSyncing}
                  className="rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  {tc("actions.close")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
