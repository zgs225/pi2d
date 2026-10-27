import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import type { DeviceEntry } from "@/features/status/queries";

import { ErrorBlock, LoadingBlock, StatusCard, StatusEmpty } from "./card-parts";

const KIND_ICON: Record<string, IconName> = {
    phone: "phone",
    tablet: "tablet",
    laptop: "laptop",
};

export function deviceKey(device: DeviceEntry): string {
    return device.id || device.deviceId || device.name;
}

/** The daemon reports `lastSeenAt`; older builds reported `lastActiveAt`. */
export function deviceLastActive(device: DeviceEntry): number | null {
    const ts = device.lastSeenAt ?? device.lastActiveAt;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

export interface DevicesCardProps {
    devices: DeviceEntry[];
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    onRevoke: (device: DeviceEntry) => Promise<void>;
}

/** Card 6 — paired devices with kind icon, last active and confirm-revoke. */
export function DevicesCard({ devices, loading, error, onRetry, onRevoke }: DevicesCardProps) {
    const { t } = useTranslation();
    const [target, setTarget] = useState<DeviceEntry | null>(null);
    const visible = devices.filter((device) => !device.revokedAt);

    async function confirm() {
        if (!target) return;
        await onRevoke(target);
        setTarget(null);
    }

    return (
        <StatusCard
            title={t("status.devices")}
            icon="phone"
            headExtra={<span className="card__sub">{t("status.deviceCount", { n: visible.length })}</span>}
        >
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={3} />
            ) : visible.length === 0 ? (
                <StatusEmpty icon="phone" title={t("status.noDevicesTitle")} text={t("status.noDevicesText")} />
            ) : (
                <div className="device-list">
                    {visible.map((device) => {
                        return (
                            <div className="device-row" key={deviceKey(device)} data-device-id={deviceKey(device)}>
                                <span className="device-icon">
                                    <Icon name={KIND_ICON[device.kind] ?? "phone"} />
                                </span>
                                <div className="grow device-main">
                                    <div className="device-name truncate">{device.name}</div>
                                    <div className="device-meta faint">{device.kind}</div>
                                </div>
                                <span className="device-time faint">
                                    <RelativeTime ts={deviceLastActive(device)} />
                                </span>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="status-icon-btn"
                                    aria-label={`${t("status.revoke")} ${device.name}`}
                                    title={t("status.revoke")}
                                    onClick={() => setTarget(device)}
                                >
                                    <Icon name="revoke" />
                                </Button>
                            </div>
                        );
                    })}
                </div>
            )}

            <ConfirmDialog
                open={target != null}
                onOpenChange={(open) => {
                    if (!open) setTarget(null);
                }}
                title={t("status.revokeTitle")}
                description={target ? t("status.revokeText", { name: target.name }) : undefined}
                confirmLabel={t("status.revoke")}
                onConfirm={confirm}
            />
        </StatusCard>
    );
}
