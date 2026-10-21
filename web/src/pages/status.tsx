import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shared/page-header";
import { useConnectionStore } from "@/stores/connection";

/** Placeholder for the single-server status page; W7b fills the cards. */
export function StatusPage() {
    const { t } = useTranslation();
    const server = useConnectionStore((state) => state.server);
    const subtitle = server ? `${server.name ?? "pi2.nvim"} · ${server.hostname ?? ""}` : t("status.notConnectedText");

    return <PageHeader title={t("status.title")} subtitle={subtitle} docTitle={t("nav.status")} size="lg" />;
}
