import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "@/locales/en.json";
import zh from "@/locales/zh.json";

export const LANGUAGES = ["zh", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_STORAGE_KEY = "pi2-lang";
const SHORT: Record<Language, string> = { zh: "中", en: "EN" };

export function isLanguage(value: unknown): value is Language {
    return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** `pi2-lang` wins; otherwise follow the browser (zh* → zh, anything else → en). */
export function detectLanguage(): Language {
    try {
        const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
        if (isLanguage(saved)) return saved;
    } catch {
        /* private mode */
    }
    const nav = String(navigator.language || "zh").toLowerCase();
    return nav.startsWith("zh") ? "zh" : "en";
}

export function localeFor(language: Language): string {
    return language === "zh" ? "zh-CN" : "en-US";
}

void i18n.use(initReactI18next).init({
    resources: {
        zh: { translation: zh },
        en: { translation: en },
    },
    lng: detectLanguage(),
    fallbackLng: "zh",
    supportedLngs: [...LANGUAGES],
    load: "currentOnly",
    // The design catalog is flat and uses dotted keys, so disable i18next's separators.
    keySeparator: false,
    nsSeparator: false,
    // The design catalog interpolates with single braces: "{n} minutes ago".
    interpolation: { prefix: "{", suffix: "}", escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
});

if (typeof document !== "undefined") {
    document.documentElement.lang = localeFor(i18n.language as Language);
}

/** Switch language and persist it to `pi2-lang` (the design's storage key). */
export async function setLanguage(language: Language): Promise<void> {
    if (!isLanguage(language)) return;
    await i18n.changeLanguage(language);
    try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
        /* private mode */
    }
    if (typeof document !== "undefined") {
        document.documentElement.lang = localeFor(language);
    }
}

export function currentLanguage(): Language {
    return isLanguage(i18n.language) ? i18n.language : "zh";
}

/** Localized language name, e.g. Chinese UI → 中文 / 英文; English UI → Chinese / English. */
export function languageLabel(language: Language): string {
    return i18n.t(`language.${language}`);
}

export function languageShort(language: Language): string {
    return SHORT[language];
}

/**
 * Port of the prototype's `I18N.plural`: pick `key.one` / `key.other` through
 * `Intl.PluralRules`, falling back to the base key when the suffix is absent.
 */
export function plural(key: string, n: number, params?: Record<string, unknown>): string {
    let category = n === 1 ? "one" : "other";
    try {
        category = new Intl.PluralRules(localeFor(currentLanguage())).select(n);
    } catch {
        /* fall back to one/other */
    }
    const suffixed = `${key}.${category}`;
    const values = { ...params, n };
    return i18n.exists(suffixed) ? i18n.t(suffixed, values) : i18n.t(key, values);
}

export default i18n;
