import { useTranslation } from "react-i18next";
import { SessionSyncPanel } from "@/components/extensions/session-sync-panel";

export default function SessionsPage() {
  const { t: tNav } = useTranslation("navigation");

  return (
    <div className="flex flex-1 flex-col min-h-0 -mb-6">
      <div className="shrink-0 pb-3">
        <h2 className="select-none text-2xl font-bold tracking-tight">
          {tNav("sessions")}
        </h2>
      </div>

      <SessionSyncPanel />
    </div>
  );
}
