import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";

/**
 * Brand story (left 40% at ≥900px): logo, title, one-line pitch, three
 * capability bullets and the quiet "token stays on this device" badge.
 */
export function ConnectHero() {
    const { t } = useTranslation();
    const features = [
        t("connect.featureOne", { defaultValue: "Workspaces and sessions in real time" }),
        t("connect.featureTwo", { defaultValue: "Subagents and background tasks in one place" }),
        t("connect.featureThree", { defaultValue: "Scoped read / steer / apply access" }),
    ];

    return (
        <section className="cn-hero" aria-labelledby="cn-hero-title">
            <img className="cn-hero__logo" src="/pi2-nvim.png" alt="" />
            <h1 className="cn-hero__title" id="cn-hero-title">
                {t("connect.heroTitle", { defaultValue: "Connect your pi2" })}
            </h1>
            <p className="cn-hero__text">
                {t("connect.heroText", {
                    defaultValue:
                        "One browser, one pi2 instance — continue your Neovim sessions from any device.",
                })}
            </p>
            <ul className="cn-features">
                {features.map((label) => (
                    <li className="cn-feature" key={label}>
                        <span className="cn-ico cn-feature__ico">
                            <Icon name="check" />
                        </span>
                        <span>{label}</span>
                    </li>
                ))}
            </ul>
            <div className="cn-secure">
                <Icon name="plug" />
                <span>{t("connect.secureBadge", { defaultValue: "Token stays on this device" })}</span>
            </div>
        </section>
    );
}
