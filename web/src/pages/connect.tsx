import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/shared/page-header";

/** Placeholder for the pairing entry page; W7b builds the manual/scan flows. */
export function ConnectPage() {
    const { t } = useTranslation();
    return (
        <div className="mx-auto w-full max-w-[32rem]">
            <PageHeader
                title={t("connect.title")}
                subtitle={t("connect.subtitle")}
                docTitle={t("connect.title")}
            >
                <p className="muted mt-3 flex items-start gap-2 text-[.8125rem]">
                    <Icon name="alert" className="mt-0.5 shrink-0" />
                    <span>{t("connect.secureNote")}</span>
                </p>
            </PageHeader>
        </div>
    );
}
