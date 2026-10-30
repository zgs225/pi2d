import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KV } from "@/components/ui/kv";
import { StatusDot } from "@/components/ui/status-dot";
import { toast } from "@/components/ui/toast";
import { ConnectHero } from "@/features/connect/hero";
import { ManualConnectForm, pairErrorMessage, type ManualConnectInput } from "@/features/connect/manual-form";
import {
    clearPairMeta,
    isPairCode,
    maskSecret,
    normalizePairCode,
    parseEndpoint,
    readPairMeta,
    redeemPairing,
    safePairNext,
    writePairMeta,
    type PairMeta,
    type PairTarget,
} from "@/features/connect/pairing";
import { deriveServerIdentity, type InfoExtras } from "@/features/status/server";
import { LiveUptime } from "@/features/status/uptime";
import { useInfoQuery } from "@/features/status/queries";
import { getDeviceToken, setDeviceToken } from "@/lib/api";
import { useConnectionStore } from "@/stores/connection";

import "@/styles/pages/connect.css";

/**
 * Port default for the manual form. The loaded daemon info wins; otherwise the
 * port this console was served from, else the scheme default. Never a literal.
 */
function defaultPortFor(infoPort: number | null | undefined): string {
    if (typeof infoPort === "number" && Number.isFinite(infoPort) && infoPort > 0) return String(infoPort);
    if (typeof window === "undefined") return "";
    const { port, protocol } = window.location;
    if (port) return port;
    return protocol === "https:" ? "443" : "80";
}

export function ConnectPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const searchStr = useRouterState({ select: (state) => state.location.searchStr });
    const search = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
    const next = useMemo(() => safePairNext(search.get("next")), [search]);
    const codeParam = useMemo(() => {
        const raw = normalizePairCode(search.get("code"));
        return isPairCode(raw) ? raw : "";
    }, [search]);

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
    /** Connected state: the re-pair panel (the manual form) expands in place. */
    const [repairOpen, setRepairOpen] = useState(false);
    /** `/connect?…&auto=1` (from a `/pair/<CODE>` link): pair with no input. */
    const autoParam = useMemo(() => {
        const raw = search.get("auto");
        return raw === "1" || raw === "true";
    }, [search]);
    const originTarget = useMemo(() => {
        if (typeof window === "undefined") return null;
        const parsed = parseEndpoint(window.location.origin, "");
        return "error" in parsed ? null : parsed;
    }, []);
    const autoAttempted = useRef(false);
    const [autoPairing, setAutoPairing] = useState(() => autoParam && codeParam !== "" && !paired);
    const [autoError, setAutoError] = useState<string | null>(null);
    const [disconnectOpen, setDisconnectOpen] = useState(false);
    const hostInputRef = useRef<HTMLInputElement | null>(null);
    const formId = useId();

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
    const defaultDeviceName = t("connect.defaultDeviceName");
    const osLabel = info.data?.os || info.data?.platform || server.os || "—";
    // Host uptime: this row labels it "uptime", and pinning it to the daemon
    // process made a five-day-old box read "3m" after a restart.
    const uptimeMs =
        typeof info.data?.hostUptimeMs === "number"
            ? info.data.hostUptimeMs
            : server.hostUptimeSec != null
              ? server.hostUptimeSec * 1000
              : null;
    const defaultPort = defaultPortFor(info.data?.port ?? server.port);

    /**
     * One pairing path for the zero-input link and the manual form: redeem
     * against the public endpoint, persist token + metadata, then follow the
     * allow-listed `next`.
     */
    const finishPairing = useCallback(
        async (target: PairTarget, deviceName: string) => {
            const result = await redeemPairing({
                endpoint: target.endpoint,
                code: target.code,
                deviceName,
            });
            setDeviceToken(result.token);
            connect({ endpoint: target.endpoint, deviceName, token: result.token });
            const nextMeta: PairMeta = {
                deviceName,
                kind: result.kind,
                pairedAt: Date.now(),
            };
            writePairMeta(nextMeta);
            setMeta(nextMeta);
            toast.success(t("connect.connected", { name: target.name }));
            navigate({ href: next });
        },
        [connect, navigate, next, t],
    );

    /**
     * A pairing link carries everything the form would ask for: the endpoint is
     * the origin the page was loaded from (host + port), the code is in the URL,
     * and the device name is the localized default. Redeem it immediately; only a
     * rejected/expired code falls back to the prefilled form.
     */
    useEffect(() => {
        if (!autoParam || !codeParam || paired || originTarget === null || autoAttempted.current) return;
        autoAttempted.current = true;
        setAutoPairing(true);
        setAutoError(null);
        void (async () => {
            try {
                await finishPairing(
                    {
                        endpoint: originTarget.endpoint,
                        code: codeParam,
                        name: originTarget.hostname,
                        hostname: originTarget.hostname,
                        port: originTarget.port,
                    },
                    defaultDeviceName,
                );
            } catch (error) {
                const message = t(pairErrorMessage(error));
                setAutoError(message);
                toast.error(message);
                setAutoPairing(false);
            }
        })();
    }, [autoParam, codeParam, paired, originTarget, finishPairing, defaultDeviceName, t]);

    async function handleManual(input: ManualConnectInput) {
        let hostname = "";
        let port = originTarget?.port ?? 0;
        try {
            const url = new URL(input.endpoint);
            hostname = url.hostname;
            port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
        } catch {
            /* validate host/port above guarantees a parseable endpoint */
        }
        await finishPairing(
            { endpoint: input.endpoint, code: input.code, name: hostname, hostname, port },
            input.deviceName,
        );
    }

    function handleDisconnect() {
        disconnect();
        clearPairMeta();
        setMeta(null);
        setRepairOpen(false);
        toast.success(t("connect.disconnected"));
    }

    function renderManualForm(expanded: boolean, primary: boolean) {
        return (
            <ManualConnectForm
                id={formId}
                expanded={expanded}
                primary={primary}
                onConnect={handleManual}
                hostInputRef={hostInputRef}
                defaultDeviceName={defaultDeviceName}
                defaultPort={defaultPort}
                initialCode={codeParam}
                initialHost={autoParam ? originTarget?.hostname : undefined}
                initialPort={autoParam && originTarget ? String(originTarget.port) : undefined}
            />
        );
    }

    /** Connected: summary + back (primary by default) / re-pair / disconnect. */
    function connectedPanel() {
        return (
            <section className="card card--quiet cn-card cn-state" aria-labelledby="cn-state-name">
                <div className="cn-state__head">
                    <StatusDot status="ok" className="dot--lg" />
                    <h2 className="cn-state__name" id="cn-state-name">
                        {server.name || "—"}
                    </h2>
                    <Badge className="badge--outline cn-state__badge">{t("connect.statePaired")}</Badge>
                </div>

                <div className="cn-kvs">
                    <KV label={t("connect.hostname")} mono>
                        {info.data?.hostname || server.hostname || "—"}
                    </KV>
                    <KV label={t("connect.endpoint")} mono>
                        {storedEndpoint || server.endpoint || "—"}
                    </KV>
                    <KV label={t("connect.version")}>{info.data?.version || meta?.server?.version || "—"}</KV>
                    <KV label={t("connect.device")}>{storedDeviceName || meta?.deviceName || "—"}</KV>
                    <KV label={t("connect.lastConnected")}>
                        <RelativeTime ts={connectedAt || meta?.pairedAt || null} />
                    </KV>
                </div>

                <div className="cn-actions">
                    <div className="cn-actions__main">
                        <Link
                            to="/workspaces"
                            className={repairOpen ? "btn" : "btn btn--primary"}
                            data-testid="connect-back"
                        >
                            <Icon name="folder" />
                            {t("connect.backToWorkspaces")}
                        </Link>
                        <Button
                            variant="ghost"
                            className="cn-actions__repair"
                            aria-expanded={repairOpen}
                            aria-controls="cn-repair"
                            data-testid="connect-repair"
                            onClick={() => setRepairOpen((open) => !open)}
                        >
                            <Icon name="refresh" />
                            {t("connect.reconnect")}
                        </Button>
                    </div>
                    <Button
                        variant="danger"
                        className="cn-actions__danger"
                        data-testid="connect-disconnect"
                        onClick={() => setDisconnectOpen(true)}
                    >
                        <Icon name="plug" />
                        {t("connect.disconnect")}
                    </Button>
                </div>

                <div className="cn-repair" id="cn-repair" hidden={!repairOpen} data-testid="connect-repair-panel">
                    {renderManualForm(repairOpen, repairOpen)}
                </div>

                <details className="cn-details">
                    <summary>
                        <span className="cn-ico cn-details__chev">
                            <Icon name="chevron-down" />
                        </span>
                        <span>{t("connect.details", { defaultValue: "Connection details" })}</span>
                    </summary>
                    <div className="cn-details__body">
                        <KV label={t("connect.token")} mono>
                            {maskSecret(getDeviceToken() ?? "") || "—"}
                        </KV>
                        <KV label={t("connect.pluginVersion")}>
                            {info.data?.pluginVersion || meta?.server?.pluginVersion || "—"}
                        </KV>
                        <KV label={t("connect.os")}>{osLabel}</KV>
                        <KV label={t("connect.uptime")}>
                            <LiveUptime ms={uptimeMs} />
                        </KV>
                        <p className="cn-note">
                            <span className="cn-ico">
                                <Icon name="alert" />
                            </span>
                            <span>{t("connect.secureNote")}</span>
                        </p>
                        <p className="cn-note">
                            <span className="cn-ico">
                                <Icon name="alert" />
                            </span>
                            <span>{t("connect.scanWarning")}</span>
                        </p>
                    </div>
                </details>
            </section>
        );
    }

    /** Unconnected: the manual form is the single path and the primary action. */
    function unconnectedPanel() {
        return (
            <section className="card card--quiet cn-card" aria-labelledby="cn-card-title">
                <div className="cn-card__head">
                    <h2 className="cn-card__title" id="cn-card-title">
                        {t("connect.emptyTitle")}
                    </h2>
                    <p className="cn-card__sub">{t("connect.emptyText")}</p>
                </div>

                <div className="cn-qr" aria-hidden="true">
                    <Icon name="qr" />
                </div>

                {autoError ? (
                    <div className="cn-error" role="alert" data-testid="connect-auto-error">
                        <span className="cn-ico">
                            <Icon name="alert" />
                        </span>
                        <span>{autoError}</span>
                    </div>
                ) : null}

                {renderManualForm(true, true)}
            </section>
        );
    }

    return (
        <div className="cn">
            <div className="cn-shell">
                <ConnectHero />
                <div className="cn-col">
                    {paired ? (
                        connectedPanel()
                    ) : autoPairing ? (
                        <section className="card card--quiet cn-card" data-testid="connect-auto">
                            <div className="cn-card__head">
                                <h2 className="cn-card__title">{t("connect.pairingAuto")}</h2>
                                <p className="cn-card__sub">{t("connect.connecting")}</p>
                            </div>
                        </section>
                    ) : (
                        unconnectedPanel()
                    )}
                </div>
            </div>

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
