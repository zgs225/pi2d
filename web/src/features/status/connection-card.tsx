import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import { KV } from "@/components/ui/kv";
import { toast } from "@/components/ui/toast";
import { drawQr } from "@/features/status/qr";
import type { PairCodeResponse } from "@/features/status/queries";
import type { ServerIdentity } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard } from "./card-parts";

function CopyButton({ value, label }: { value: string; label: string }) {
    const { t } = useTranslation();

    async function copy() {
        try {
            if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
            await navigator.clipboard.writeText(value);
            toast.success(t("common.copied", { label }));
        } catch {
            toast.error(t("common.copyFailed"));
        }
    }

    return (
        <Button
            variant="ghost"
            size="icon"
            className="status-copy"
            title={t("common.copy", { label })}
            aria-label={t("common.copy", { label })}
            onClick={() => void copy()}
        >
            <Icon name="copy" />
        </Button>
    );
}

/** `.addr` — a labelled address that wraps instead of truncating. */
function Address({ label, value }: { label: string; value: string }) {
    return (
        <div className="addr">
            <div className="addr__label">{label}</div>
            <div className="addr__row">
                <code className="addr__value">{value}</code>
                <CopyButton value={value} label={label} />
            </div>
        </div>
    );
}

/**
 * 画 daemon 下发的真矩阵：`rows` 每行一串 `0`/`1`。主题切换和容器缩放时重绘。
 */
function QrCanvas({ rows, label }: { rows: string[]; label: string }) {
    const ref = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const draw = () => drawQr(canvas, rows);
        draw();

        window.addEventListener("resize", draw);
        const observer =
            typeof MutationObserver === "undefined" ? null : new MutationObserver(draw);
        observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => {
            window.removeEventListener("resize", draw);
            observer?.disconnect();
        };
    }, [rows]);

    return (
        <canvas
            ref={ref}
            className="qr-canvas"
            role="img"
            aria-label={label}
            data-qr-size={rows.length}
        />
    );
}

export interface ConnectionCardProps {
    server: ServerIdentity;
    deviceName: string;
    connectedAt: number | null;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    onDisconnect: () => void;
    /** Fresh pairing code minted by the daemon (`POST /api/v1/pair`). */
    pairCode: PairCodeResponse | undefined;
    pairLoading: boolean;
    pairError: string | null;
    onRetryPair: () => void;
}

/** Minutes left before the minted code expires (never negative). */
export function pairMinutesLeft(expiresAt: number | null | undefined, now = Date.now()): number | null {
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
    return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

/**
 * Card 7 — two internal columns: addresses / mDNS / endpoint / device / pairing
 * code / security notes on the left, the QR with the pairing hint and the expiry
 * on the right. Both actions are non-primary (the status page carries 0 primary
 * buttons).
 */
export function ConnectionCard({
    server,
    deviceName,
    connectedAt,
    loading,
    error,
    onRetry,
    onDisconnect,
    pairCode,
    pairLoading,
    pairError,
    onRetryPair,
}: ConnectionCardProps) {
    const { t } = useTranslation();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const code = String(pairCode?.code ?? "").trim();
    // URL 由 daemon 决定（mint 时选好 base），客户端不再拼接。
    const url = String(pairCode?.url ?? "").trim();
    /** 真矩阵；URL 过长时 daemon 不下发 `qr`，此时只展示可点/可拷的链接。 */
    const qrRows = Array.isArray(pairCode?.qr?.rows) ? pairCode.qr.rows : [];
    const minutes = pairMinutesLeft(pairCode?.expiresAt);

    return (
        <StatusCard title={t("status.connection")} icon="qr">
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={6} />
            ) : (
                <>
                    <div className="conn-grid">
                        <div className="conn-left">
                            <Address label={t("status.local")} value={server.localAddress} />
                            <Address label={t("status.network")} value={server.networkAddress} />

                            <div className="kv-list conn-kv">
                                <KV label={t("status.mdns")} mono>
                                    {server.mdns}
                                </KV>
                                <KV
                                    label={t("connect.endpoint")}
                                    className="status-kv--copy status-kv--wide"
                                    valueClassName="status-kv__val"
                                >
                                    <span className="mono status-kv__mono">{server.endpoint}</span>
                                    <CopyButton value={server.endpoint} label={t("connect.endpoint")} />
                                </KV>
                                <KV label={t("connect.device")}>{deviceName || "—"}</KV>
                                <KV label={t("status.lastConnected")}>
                                    <RelativeTime ts={connectedAt} />
                                </KV>
                            </div>

                            <div className="pair-code-block">
                                <div className="section-label">
                                    {t("status.pairingTitle", { defaultValue: "Pairing" })}
                                </div>
                                {pairError ? (
                                    <ErrorBlock message={pairError} onRetry={onRetryPair} />
                                ) : pairLoading ? (
                                    <LoadingBlock rows={1} />
                                ) : (
                                    <div className="pair-code mono" data-testid="pairing-code">
                                        {code || "—"}
                                    </div>
                                )}
                            </div>

                            <div className="security-note">
                                <div className="security-item">{t("status.securityLocal")}</div>
                                <div className="security-item">{t("status.securityToken")}</div>
                                {minutes != null ? (
                                    <div className="security-item">
                                        {t("status.securityExpiry", { n: minutes })}
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        <div className="conn-right">
                            <div className="qr-wrap">
                                {qrRows.length ? (
                                    <QrCanvas rows={qrRows} label={t("status.qrAria")} />
                                ) : url ? (
                                    <code className="qr-link mono" data-testid="pair-url">
                                        {url}
                                    </code>
                                ) : null}
                                <div className="pair-hint faint">
                                    <Icon name="phone" />
                                    <span>{t("status.pairHint")}</span>
                                </div>
                                {minutes != null ? (
                                    <div className="pair-expiry faint">
                                        {t("status.pairingExpires", {
                                            n: minutes,
                                            defaultValue: "Expires in {n} min",
                                        })}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    <div className="status-conn-actions">
                        <a className="btn btn--ghost btn--sm" href="/connect?next=%2Fstatus">
                            <Icon name="refresh" />
                            {t("connect.reconnect")}
                        </a>
                        <span className="spacer" />
                        <Button
                            variant="ghost"
                            size="sm"
                            className="btn--danger"
                            onClick={() => setConfirmOpen(true)}
                        >
                            <Icon name="plug" />
                            {t("connect.disconnect")}
                        </Button>
                    </div>
                </>
            )}

            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title={t("connect.disconnectTitle")}
                description={t("connect.disconnectText")}
                confirmLabel={t("connect.disconnect")}
                onConfirm={onDisconnect}
            />
        </StatusCard>
    );
}
