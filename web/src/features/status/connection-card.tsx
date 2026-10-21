import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KV, KVList } from "@/components/ui/kv";
import { toast } from "@/components/ui/toast";
import { drawQr } from "@/features/status/qr";
import type { PairCodeResponse } from "@/features/status/queries";
import type { ServerIdentity } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard } from "./card-parts";

function scopeTone(scope: string): "default" | "info" | "ok" {
    if (scope === "read") return "default";
    if (scope === "steer") return "info";
    if (scope === "apply") return "ok";
    return "default";
}

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

function AddressBlock({ label, value }: { label: string; value: string }) {
    return (
        <div className="addr-block">
            <div className="addr-label muted">{label}</div>
            <div className="addr-row">
                <code className="mono truncate grow">{value}</code>
                <CopyButton value={value} label={label} />
            </div>
        </div>
    );
}

function QrCanvas({ seed, label }: { seed: string; label: string }) {
    const ref = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const draw = () => drawQr(canvas, seed);
        draw();

        if (typeof MutationObserver === "undefined") return;
        const observer = new MutationObserver(draw);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, [seed]);

    return <canvas ref={ref} className="qr-canvas" role="img" aria-label={label} />;
}

export interface ConnectionCardProps {
    server: ServerIdentity;
    deviceName: string;
    scopes: string[];
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
 * The live pairing code block: code, expiry, pairing URL and the QR drawn from
 * that URL. Failures are retried in place instead of showing `—`.
 */
function PairingBlock({
    pairCode,
    loading,
    error,
    fallbackUrl,
    onRetry,
}: {
    pairCode: PairCodeResponse | undefined;
    loading: boolean;
    error: string | null;
    fallbackUrl: string;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    const code = String(pairCode?.code ?? "").trim();
    const url = String(pairCode?.url ?? "").trim() || (code ? `${fallbackUrl}/#pair=${code}` : "");
    const minutes = pairMinutesLeft(pairCode?.expiresAt);

    if (error) return <ErrorBlock message={error} onRetry={onRetry} />;
    if (loading) return <LoadingBlock rows={3} />;
    if (!code) return <ErrorBlock message={t("connect.pairFailed")} onRetry={onRetry} />;

    return (
        <div className="qr-wrap">
            <QrCanvas seed={url || code} label={t("status.qrAria")} />
            <div className="pair-code" data-testid="pairing-code">
                {code}
            </div>
            {minutes != null ? <div className="pair-expiry muted">{t("status.securityExpiry", { n: minutes })}</div> : null}
            {url ? (
                <div className="addr-row" data-testid="pairing-url">
                    <code className="mono truncate grow">{url}</code>
                    <CopyButton value={url} label={t("connect.pairingLink")} />
                </div>
            ) : null}
            <div className="pair-hint muted">
                <Icon name="phone" />
                <span>{t("status.pairHint")}</span>
            </div>
        </div>
    );
}

/** Card 7 — addresses, mDNS, pairing code/QR, scopes, last connection, actions. */
export function ConnectionCard({
    server,
    deviceName,
    scopes,
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

    return (
        <StatusCard title={t("status.connection")} icon="qr">
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={6} />
            ) : (
                <>
                    <div className="connect-grid">
                        <div className="connect-addr">
                            <AddressBlock label={t("status.local")} value={server.localAddress} />
                            <AddressBlock label={t("status.network")} value={server.networkAddress} />
                            <KV label={t("status.mdns")} mono>
                                {server.mdns}
                            </KV>
                            <KV label={t("connect.endpoint")} valueClassName="status-endpoint">
                                <span className="mono truncate">{server.endpoint}</span>
                                <CopyButton value={server.endpoint} label={t("connect.endpoint")} />
                            </KV>
                            <KV label={t("connect.device")}>{deviceName || "—"}</KV>
                            <KV label={t("status.tokenScopes")} valueClassName="status-kv-val">
                                {scopes.length ? (
                                    <span className="status-scopes">
                                        {scopes.map((scope) => (
                                            <Badge key={scope} tone={scopeTone(scope)}>
                                                {scope}
                                            </Badge>
                                        ))}
                                    </span>
                                ) : (
                                    <span className="muted">—</span>
                                )}
                            </KV>
                            <KV label={t("status.lastConnected")}>
                                <RelativeTime ts={connectedAt} />
                            </KV>
                        </div>

                        <PairingBlock
                            pairCode={pairCode}
                            loading={pairLoading}
                            error={pairError}
                            fallbackUrl={server.networkAddress}
                            onRetry={onRetryPair}
                        />
                    </div>

                    <KVList className="security-note">
                        <div className="security-item">{t("status.securityLocal")}</div>
                        <div className="security-item">{t("status.securityToken")}</div>
                    </KVList>

                    <div className="status-conn-actions">
                        <a className="btn btn--sm" href="/connect?next=%2Fstatus">
                            <Icon name="refresh" />
                            {t("connect.reconnect")}
                        </a>
                        <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
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
