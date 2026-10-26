import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { navEntryFor, type PageName } from "@/components/shared/nav-list";
import { PageSheet } from "@/components/shared/page-sheet";

export interface PagePillProps {
    page: PageName;
    /** Opens the command palette (the <600 search entry lives inside the sheet). */
    onSearch: () => void;
}

/**
 * Topbar page pill, visible only <600px (CSS): current page icon + label +
 * chevron. `aria-haspopup="dialog"` + a controlled `aria-expanded`; the sheet
 * returns focus to the pill when it closes.
 */
export function PagePill({ page, onSearch }: PagePillProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const pillRef = useRef<HTMLButtonElement>(null);
    const entry = navEntryFor(page);
    const label = t("shell.pageSwitch", { page: t(entry.labelKey) });

    return (
        <>
            <button
                ref={pillRef}
                type="button"
                className="page-pill"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={label}
                title={label}
                onClick={() => setOpen(true)}
            >
                <Icon name={entry.icon} />
                <span className="page-pill__label">{t(entry.labelKey)}</span>
                <Icon name="chevron-down" />
            </button>
            <PageSheet
                open={open}
                onOpenChange={setOpen}
                page={page}
                onSearch={onSearch}
                returnFocusTo={pillRef}
            />
        </>
    );
}
