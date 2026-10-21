import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shared/page-header";

export function WorkspacesPage() {
    const { t } = useTranslation();
    return (
        <PageHeader
            title={t("workspaces.title")}
            subtitle={t("workspaces.subtitle")}
            docTitle={t("nav.workspaces")}
        />
    );
}
