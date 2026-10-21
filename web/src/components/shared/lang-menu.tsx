import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
    LANGUAGES,
    isLanguage,
    languageLabel,
    languageShort,
    setLanguage,
    type Language,
} from "@/lib/i18n";

/** Topbar language menu (globe + current language + caret), persisted to `pi2-lang`. */
export function LangMenu() {
    const { t, i18n } = useTranslation();
    const current: Language = isLanguage(i18n.language) ? i18n.language : "zh";

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className="btn btn--sm btn--ghost lang-switch"
                    title={t("shell.language")}
                    aria-label={`${t("shell.language")}: ${languageLabel(current)}`}
                >
                    <Icon name="globe" />
                    <span className="lang-switch__full">{languageLabel(current)}</span>
                    <span className="lang-switch__short">{languageShort(current)}</span>
                    <span className="lang-switch__caret">
                        <Icon name="chevron-down" />
                    </span>
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="menu-popover"
                    align="end"
                    sideOffset={4}
                    aria-label={t("shell.language")}
                >
                    <DropdownMenu.RadioGroup
                        value={current}
                        onValueChange={(value) => {
                            if (isLanguage(value)) void setLanguage(value);
                        }}
                    >
                        {LANGUAGES.map((language) => {
                            const active = language === current;
                            return (
                                <DropdownMenu.RadioItem
                                    key={language}
                                    value={language}
                                    className={cn("menu__item", active && "is-active")}
                                >
                                    <span className="grow">{languageLabel(language)}</span>
                                    {active ? (
                                        <span className="menu__check">
                                            <Icon name="check" />
                                        </span>
                                    ) : null}
                                </DropdownMenu.RadioItem>
                            );
                        })}
                    </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
