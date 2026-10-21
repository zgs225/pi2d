import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { KV } from "@/components/ui/kv";
import { toast } from "@/components/ui/toast";
import { ManualConnectForm, type ManualConnectInput } from "@/features/connect/manual-form";
import {
    clearPairMeta,
    maskSecret,
    readPairMeta,
    redeemPairing,
    safePairNext,
    scopesForIdentity,
    writePairMeta,
    type PairMeta,
    type PairTarget,
} from "@/features/connect/pairing";
import { ScanDialog } from "@/features/connect/scan-dialog";
import { deriveServerIdentity, type InfoExtras } from "@/features/status/server";
import { useInfoQuery } from "@/features/status/queries";
import { ApiError, errorI18nKey } from "@/lib/api";
import { useConnectionStore } from "@/stores/connection";

import "@/styles/pages/connect.css";

function scopeTone(scope: string): "default" | "info" | "ok" {
    if (scope === "read") return "default";
    if (scope === "steer") return "info";
    if (scope === "apply") return "ok";
    return "default";
}

function messageFor(error: unknown, t: (key: string) => string): string {
    if (error instanceof ApiError) return t(errorI18nKey(error.code));
    return t("connect.pairFailed");
}

export function ConnectPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const searchStr = useRouterState({ select: (state) => state.location.searchStr });
    const next = useMemo(
        () => safePairNext(new URLSearchParams(searchStr).get("next")),
        [searchStr],
    );

    const refreshFromStorage = useConnectionStore((state) => state.refreshFromStorage);
    const paired = useConnectionStore((state) => state.paired);
    const connect = useConnectionStore((state) => state.connect);
    const disconnect = useConnectionStore((state) => state.disconnect);
    const storedEndpoint = useConnectionStore((state) => state.endpoint);
    const storedDeviceName = useConnectionStore((state) => state.deviceName);
    const connectedAt = useConnectionStore((state) => state.connectedAt);
    const wsState = useConnectionStore((state) => state.wsState);
    const storedServer = useConnectionStore((state) => state.server);

    const [meta, setMeta] = useState<PairMeta | null>(() => readPairMeta());
    const [scanOpen, setScanOpen] = useState(false);
    const [pending, setPending] = useState<PairTarget | null>(null);
    const [pairError, setPairError] = useState<string | null>(null);
    const [redeeming, setRedeeming] = useState(false);
    const [disconnectOpen, setDisconnectOpen] = useState(false);
    const hostInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        refreshFromStorage();
    }, [refreshFromStorage]);

    useEffect(() => {
        const title = t("connect.title");
        document.title = `${title} — pi2.nvim`;
    }, [t]);

    const info = useInfoQuery(paired);
    const server = deriveServerIdentity({
        info: info.data as InfoExtras | undefined,
        endpoint: storedEndpoint,
        wsState,
        fetchedAt: info.dataUpdatedAt || null,
        nameFallback: storedServer?.name || meta?.server?.name,
    });
    const scopes = scopesForIdentity(meta, info.data);
    const defaultDeviceName = t("connect.defaultDeviceName");

    const finishPairing = useCallback(
        async (target: PairTarget, deviceName: string) => {
            const result = await redeemPairing({
                endpoint: target.endpoint,
                code: target.code,
                deviceName,
            });
            connect({ endpoint: target.endpoint, deviceName, token: result.token });
            const nextMeta: PairMeta = {
                scopes: result.scopes,
                deviceName,
                server: result.server,
                pairedAt: Date.now(),
            };
            writePairMeta(nextMeta);
            setMeta(nextMeta);
            toast.success(t("connect.connected", { name: result.server?.name || target.name }));
            navigate({ href: next });
        },
        [connect, navigate, next, t],
    );

    async function handleManual(input: ManualConnectInput) {
        const url = new URL(input.endpoint);
        await finishPairing(
            {
                endpoint: input.endpoint,
                code: input.code,
                name: url.hostname,
                hostname: url.hostname,
                port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
            },
            input.deviceName,
        );
    }

    const handleFound = useCallback((target: PairTarget) => {
        setPairError(null);
        setPending(target);
    }, []);

    async function confirmPending() {
        if (!pending || redeeming) return;
        setRedeeming(true);
        setPairError(null);
        try {
            await finishPairing(pending, defaultDeviceName);
            setPending(null);
        } catch (error) {
            const message = messageFor(error, t);
            setPairError(message);
            toast.error(message);
        } finally {
            setRedeeming(false);
        }
    }

    function handleDisconnect() {
        disconnect();
        clearPairMeta();
        setMeta(null);
        toast.success(t("connect.disconnected"));
    }

    const title = t("connect.title");
    const subtitle = t("connect.subtitle");

    return (
        <div className="cn">
            <header className="cn-head">
                <h1>{title}</h1>
                <p className="cn-sub">{subtitle}</p>
                <p className="cn-note">
                    <span className="cn-ico">
                        <Icon name="alert" />
                    </span>
                    <span>{t("connect.secureNote")}</span>
                </p>
            </header>

            {paired ? (
                <section className="card cn-card cn-summary">
                    <div className="card__head">
                        <div className="grow">
                            <h2 className="cn-card__title">
                                <span className="cn-ico">
                                    <Icon name="check" />
                                </span>
                                {t("connect.summary")}
                            </h2>
                            <div className="card__sub">{t("connect.statePaired")}</div>
                        </div>
                        <Badge tone="ok">{t("connect.statePaired")}</Badge>
                    </div>

                    <div className="cn-kvs">
                        <KV label={t("connect.server")}>{server.name || "—"}</KV>
                        <KV label={t("connect.hostname")} mono>
                            {server.hostname || "—"}
                        </KV>
                        <KV label={t("connect.endpoint")} mono>
                            {storedEndpoint || server.endpoint || "—"}
                        </KV>
                        <KV label={t("connect.version")}>
                            {info.data?.version || meta?.server?.version || "—"}
                        </KV>
                        <KV label={t("connect.pluginVersion")}>
                            {info.data?.pluginVersion || meta?.server?.pluginVersion || "—"}
                        </KV>
                        <KV label={t("connect.device")}>{storedDeviceName || meta?.deviceName || "—"}</KV>
                        <KV label={t("connect.scopes")} className="cn-kv--badges">
                            {scopes.length ? (
                                <span className="cn-scopes">
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
                        <KV label={t("connect.lastConnected")}>
                            <RelativeTime ts={connectedAt || meta?.pairedAt || null} />
                        </KV>
                    </div>

                    <div className="cn-summary__actions">
                        <Link to="/workspaces" className="btn btn--primary">
                            <Icon name="folder" />
                            {t("connect.backToWorkspaces")}
                        </Link>
                        <Button variant="ghost" onClick={() => setScanOpen(true)}>
                            <Icon name="scan" />
                            {t("connect.reconnect")}
                        </Button>
                        <Button variant="danger" onClick={() => setDisconnectOpen(true)}>
                            <Icon name="x" />
                            {t("connect.disconnect")}
                        </Button>
                    </div>
                </section>
            ) : (
                <>
                    <div className="cn-actions">
                        <Button variant="primary" className="cn-action" onClick={() => setScanOpen(true)}>
                            <Icon name="scan" />
                            {t("connect.scan")}
                        </Button>
                        <Button
                            variant="ghost"
                            className="cn-action"
                            onClick={() => hostInputRef.current?.focus()}
                        >
                            <Icon name="server" />
                            {t("connect.manual")}
                        </Button>
                    </div>
                    <ManualConnectForm
                        onConnect={handleManual}
                        hostInputRef={hostInputRef}
                        defaultDeviceName={defaultDeviceName}
                    />
                </>
            )}

            <ScanDialog
                open={scanOpen}
                onOpenChange={setScanOpen}
                onFound={handleFound}
                fallbackEndpoint={storedEndpoint}
            />

            <Modal
                open={pending != null}
                onOpenChange={(open) => {
                    if (!open && !redeeming) setPending(null);
                }}
                title={t("connect.confirmTitle")}
                footer={
                    <>
                        <Button variant="ghost" onClick={() => setPending(null)} disabled={redeeming}>
                            {t("common.cancel")}
                        </Button>
                        <Button variant="primary" onClick={() => void confirmPending()} disabled={redeeming}>
                            {redeeming ? t("connect.connecting") : t("connect.connect")}
                        </Button>
                    </>
                }
            >
                {pending ? (
                    <div>
                        <p className="cn-lead">{t("connect.scanLead")}</p>
                        <div className="cn-confirm">
                            <KV label={t("connect.server")}>{pending.name || pending.hostname}</KV>
                            <KV label={t("connect.endpoint")} mono>
                                {pending.hostname}:{pending.port}
                            </KV>
                            <KV label={t("connect.token")} mono>
                                {maskSecret(pending.code)}
                            </KV>
                        </div>
                        <div className="cn-warn">
                            <span className="cn-ico">
                                <Icon name="alert" />
                            </span>
                            <span>{t("connect.scanWarning")}</span>
                        </div>
                        {pairError ? (
                            <div className="cn-error" role="alert">
                                <span className="cn-ico">
                                    <Icon name="alert" />
                                </span>
                                <span>{pairError}</span>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </Modal>

            <ConfirmDialog
                open={disconnectOpen}
                onOpenChange={setDisconnectOpen}
                title={t("connect.disconnectTitle")}
                description={t("connect.disconnectText")}
                confirmLabel={t("connect.disconnect")}
                onConfirm={handleDisconnect}
            />
        </div>
    );
}
