import { useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shared/page-header";
import { useWorkspacesStore } from "@/stores/workspaces";

/** Placeholder for the workspace detail route; W7b/W7c fill the content. */
export function WorkspacePage() {
    const { t } = useTranslation();
    const { workspaceId } = useParams({ strict: false });
    const workspace = useWorkspacesStore((state) => state.items.find((item) => item.workspaceId === workspaceId));

    return (
        <PageHeader
            title={workspace?.name ?? t("workspaces.title")}
            subtitle={workspace?.cwd ?? workspaceId}
            docTitle={t("workspaces.title")}
        />
    );
}
