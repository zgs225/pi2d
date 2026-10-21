import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Seg, type SegOption } from "@/components/ui/seg";

type ThemeValue = "light" | "dark" | "system";

const THEMES: ThemeValue[] = ["light", "dark", "system"];

function isThemeValue(value: string | undefined): value is ThemeValue {
    return value === "light" || value === "dark" || value === "system";
}

/** Topbar light/dark/system segment; next-themes persists it to `pi2-theme`. */
export function ThemeMenu() {
    const { t } = useTranslation();
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);

    useEffect(() => setMounted(true), []);

    const value: ThemeValue = mounted && isThemeValue(theme) ? theme : "system";
    const options: SegOption<ThemeValue>[] = THEMES.map((item) => ({
        value: item,
        label: t(`shell.${item}`),
    }));

    return (
        <Seg
            value={value}
            options={options}
            onChange={setTheme}
            ariaLabel={t("shell.theme")}
        />
    );
}
