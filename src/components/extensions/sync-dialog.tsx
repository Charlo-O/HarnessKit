import { useEffect, useRef } from "react";
import { SyncPanel } from "@/components/extensions/sync-panel";
import { useFocusTrap } from "@/hooks/use-focus-trap";

interface SyncDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SyncDialog({ open, onClose }: SyncDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  return (
    <div
      className="grid transition-[grid-template-rows] duration-[250ms]"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
    >
      <div className="overflow-hidden">
        <div ref={dialogRef} role="dialog" aria-modal="true">
          <SyncPanel active={open} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
