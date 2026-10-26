import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";

export interface StatusCardProps {
    title: ReactNode;
    icon: IconName;
    headExtra?: ReactNode;
    className?: string;
    children: ReactNode;
}

/** `.card.card--quiet.status-card` — 1px --border-subtle, --radius-lg, 18px padding. */
export function StatusCard({ title, icon, headExtra, className, children }: StatusCardProps) {
    return (
        <section className={className ? `card card--quiet status-card ${className}` : "card card--quiet status-card"}>
            <div className="card__head">
                <div className="card__title">
                    <Icon name={icon} />
                    {title}
                </div>
                <div className="spacer" />
                {headExtra ?? null}
            </div>
            {children}
        </section>
    );
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
    const { t } = useTranslation();
    return (
        <div className="status-loading" role="status" aria-label={t("common.loading")}>
            {Array.from({ length: rows }, (_, index) => (
                <span key={index} className="skeleton skeleton--row" />
            ))}
        </div>
    );
}

export interface ErrorBlockProps {
    message: string;
    onRetry?: () => void;
}

export function ErrorBlock({ message, onRetry }: ErrorBlockProps) {
    const { t } = useTranslation();
    return (
        <Empty
            className="status-error"
            icon={<Icon name="alert" size={20} />}
            description={message}
            action={
                onRetry ? (
                    <Button size="sm" onClick={onRetry}>
                        <Icon name="refresh" />
                        {t("common.retry")}
                    </Button>
                ) : undefined
            }
        />
    );
}

export interface StatusEmptyProps {
    icon: IconName;
    title: string;
    text: string;
}

export function StatusEmpty({ icon, title, text }: StatusEmptyProps) {
    return (
        <Empty
            className="status-empty"
            icon={<Icon name={icon} size={20} />}
            title={title}
            description={text}
        />
    );
}
