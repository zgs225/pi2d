import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/icons";
import { LANGUAGES, currentLanguage, languageLabel, setLanguage, type Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type ThemeValue = "light" | "dark" | "system";

const THEMES: ThemeValue[] = ["light", "dark", "system"];
const THEME_ICON: Record<ThemeValue, IconName> = { light: "sun", dark: "moon", system: "monitor" };

function isThemeValue(value: string | undefined): value is ThemeValue {
    return value === "light" || value === "dark" || value === "system";
}

/**
 * Single topbar preference entry (appearance + language), per v0.1.1 CHG-04:
 * one sliders trigger, `role=menu` popover with two `role=group`s of
 * `menuitemradio` rows, `aria-checked` + check mark, roving focus
 * (ArrowDown/ArrowUp/Home/End), Escape returns focus to the trigger, and a
 * click outside closes it.
 */
export function PrefsMenu() {
    const { t } = useTranslation();
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => setMounted(true), []);

    const themeValue: ThemeValue = mounted && isThemeValue(theme) ? theme : "system";
    const language: Language = currentLanguage();

    /** Focus target on open: the active radio, else the first row (prototype `open()`). */
    useEffect(() => {
        if (!open) return;
        const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
        if (!rows.length) return;
        const active = menuRef.current?.querySelector<HTMLElement>(".menu__item.is-active");
        (active ?? rows[0])?.focus();
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDocumentClick = (event: MouseEvent) => {
            if (wrapRef.current?.contains(event.target as Node)) return;
            setOpen(false);
        };
        document.addEventListener("click", onDocumentClick);
        return () => document.removeEventListener("click", onDocumentClick);
    }, [open]);

    function close(focusBack: boolean) {
        setOpen(false);
        if (focusBack) triggerRef.current?.focus();
    }

    function rows(): HTMLElement[] {
        return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    }

    function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const list = rows();
        if (!list.length) return;
        const index = list.indexOf(document.activeElement as HTMLElement);
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                list[(index + 1) % list.length]?.focus();
                break;
            case "ArrowUp":
                event.preventDefault();
                list[(index - 1 + list.length) % list.length]?.focus();
                break;
            case "Home":
                event.preventDefault();
                list[0]?.focus();
                break;
            case "End":
                event.preventDefault();
                list[list.length - 1]?.focus();
                break;
            case "Escape":
                event.preventDefault();
                event.stopPropagation();
                close(true);
                break;
            default:
                break;
        }
    }

    function chooseLanguage(next: Language) {
        if (next === language) {
            close(true);
            return;
        }
        void setLanguage(next);
        close(true);
    }

    return (
        <div ref={wrapRef} className={cn("lang-menu", "prefs", open && "open")}>
            <button
                ref={triggerRef}
                type="button"
                className="icon-btn pref-trigger"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t("shell.preferences")}
                title={t("shell.preferences")}
                onClick={() => setOpen((value) => !value)}
                onKeyDown={(event) => {
                    if (event.key !== "ArrowDown") return;
                    event.preventDefault();
                    setOpen(true);
                }}
            >
                <Icon name="sliders" />
            </button>
            {open ? (
                <div
                    ref={menuRef}
                    className="menu"
                    role="menu"
                    aria-label={t("shell.preferences")}
                    onKeyDown={onMenuKeyDown}
                >
                    <div className="menu__label">{t("shell.appearance")}</div>
                    <div role="group" aria-label={t("shell.appearance")} data-theme-seg="">
                        {THEMES.map((value) => {
                            const active = themeValue === value;
                            const label = t(`shell.${value}`);
                            return (
                                <button
                                    key={value}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={active}
                                    aria-label={`${t("shell.theme")}: ${label}`}
                                    data-v={value}
                                    className={cn("menu__item", active && "is-active")}
                                    onClick={() => setTheme(value)}
                                >
                                    <Icon name={THEME_ICON[value]} />
                                    <span className="grow">{label}</span>
                                    <span className="menu__check" hidden={!active}>
                                        <Icon name="check" />
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="menu__sep" />
                    <div className="menu__label">{t("shell.language")}</div>
                    <div role="group" aria-label={t("shell.language")} data-lang-seg="">
                        {LANGUAGES.map((lang) => {
                            const active = language === lang;
                            return (
                                <button
                                    key={lang}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={active}
                                    data-lang={lang}
                                    className={cn("menu__item", active && "is-active")}
                                    onClick={() => chooseLanguage(lang)}
                                >
                                    <Icon name="globe" />
                                    <span className="grow">{languageLabel(lang)}</span>
                                    <span className="menu__check" hidden={!active}>
                                        <Icon name="check" />
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
