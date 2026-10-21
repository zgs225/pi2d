import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { StatusDot, serverDotClass } from "@/components/ui/status-dot";
import type { InfoResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";

export interface ServerChipProps {
    server?: InfoResponse | null;
    className?: string;
}

/**
 * Single-server identity chip in the topbar: status dot + server name + hostname,
 * linking to /status. Never a server picker (single-server invariant).
 */
export function ServerChip({ server: override, className }: ServerChipProps) {
    const { t } = useTranslation();
    const stored = useConnectionStore((state) => state.server);
    const server = override ?? stored;

    const name = server?.name ?? "pi2.nvim";
    const hostname =
        server?.hostname ?? (typeof window !== "undefined" ? window.location.hostname || "localhost" : "localhost");
    const status = server?.status ?? "offline";
    const dot = serverDotClass(status);
    const dotStatus = dot.replace("dot--", "") as "ok" | "attention" | "exited" | "idle";

    return (
        <Link
            to="/status"
            className={cn("server-chip", className)}
            title={t("shell.serverChip", { name })}
        >
            <StatusDot status={dotStatus} title={t(`state.${status}`)} />
            <span className="server-chip__name">{name}</span>
            <span className="server-chip__host mono">{hostname}</span>
        </Link>
    );
}
