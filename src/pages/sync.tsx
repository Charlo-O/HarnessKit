import { useTranslation } from "react-i18next";
import { AgentSyncPanel } from "@/components/extensions/agent-sync-panel";
import { SyncPanel } from "@/components/extensions/sync-panel";

export default function SyncPage() {
  const { t } = useTranslation("extensions");

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="shrink-0 pb-4">
        <h2 className="select-none text-2xl font-bold tracking-tight">
          {t("sync.title")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t("agentSync.pageDesc")}
        </p>
      </div>

      <div className="max-w-5xl space-y-4">
        <AgentSyncPanel />
        <SyncPanel />
      </div>
    </div>
  );
}
