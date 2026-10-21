import { useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shared/page-header";
import { useSessionsStore } from "@/stores/sessions";

/** Placeholder for the chat route; the session tree/message stream land in W7c. */
export function ChatPage() {
    const { t } = useTranslation();
    const { sessionId } = useParams({ strict: false });
    const session = useSessionsStore((state) => (sessionId ? state.getSession(sessionId) : undefined));

    return (
        <PageHeader
            title={session?.name ?? t("nav.chat")}
            subtitle={sessionId}
            docTitle={t("nav.chat")}
        />
    );
}

export function ChatIndexPage() {
    const { t } = useTranslation();
    return <PageHeader title={t("nav.chat")} subtitle={t("chat.search")} docTitle={t("nav.chat")} />;
}
