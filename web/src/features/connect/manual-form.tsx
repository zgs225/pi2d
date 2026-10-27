import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiError, errorI18nKey } from "@/lib/api";

import { PAIR_CODE_LENGTH, isPairCode, normalizePairCode, parseEndpoint, parsePairLink } from "./pairing";

export interface ManualConnectInput {
    endpoint: string;
    code: string;
    deviceName: string;
}

export interface ManualConnectFormProps {
    onConnect: (input: ManualConnectInput) => Promise<void>;
    hostInputRef: RefObject<HTMLInputElement | null>;
    defaultDeviceName: string;
    /** Prefill from `/connect?code=…` or the `/pair/$code` redirect. */
    initialCode?: string;
    /** Host/port prefill, e.g. the origin a pairing link was opened from. */
    initialHost?: string;
    initialPort?: string;
    /**
     * Port default derived from the loaded daemon info (the port this console
     * was served from), never a hard-coded literal.
     */
    defaultPort?: string;
    /** Stable id of the collapsible container (the toggle's `aria-controls`). */
    id?: string;
    /** Collapsed by default; the parent owns the state so it can arbitrate the primary. */
    expanded?: boolean;
    /** True when the submit button is the page's single primary action. */
    primary?: boolean;
}

/** Wrong/expired codes come back as 401 `E_UNAUTHORIZED`; the code rail is the useful message. */
export function pairErrorMessage(error: unknown): string {
    if (error instanceof ApiError) {
        if (error.code === "E_UNAUTHORIZED" || error.status === 401) return "connect.pairCodeRejected";
        return errorI18nKey(error.code);
    }
    return "connect.pairFailed";
}

/** Inline manual pairing form: host/port, 8-character pairing code, optional device name. */
export function ManualConnectForm({
    onConnect,
    hostInputRef,
    defaultDeviceName,
    initialCode,
    initialHost,
    initialPort,
    defaultPort = "",
    id: formId,
    expanded = true,
    primary = false,
}: ManualConnectFormProps) {
    const { t } = useTranslation();
    const id = useId();
    const [link, setLink] = useState("");
    const [linkError, setLinkError] = useState<string | null>(null);
    const [host, setHost] = useState(() => initialHost ?? "");
    const [port, setPort] = useState(() => initialPort ?? defaultPort);
    const [code, setCode] = useState(() => normalizePairCode(initialCode ?? ""));
    const [deviceName, setDeviceName] = useState("");
    const [hostError, setHostError] = useState<string | null>(null);
    const [portError, setPortError] = useState<string | null>(null);
    const [codeError, setCodeError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);
    const portEdited = useRef(false);

    // Expanding the manual form moves focus to the host field (prototype focusHost).
    useEffect(() => {
        if (expanded) hostInputRef.current?.focus();
    }, [expanded, hostInputRef]);

    // The daemon port arrives with `/info`: an untouched field adopts it instead of
    // keeping the endpoint-derived value the form mounted with.
    useEffect(() => {
        if (portEdited.current || initialPort) return;
        setPort(defaultPort);
    }, [defaultPort, initialPort]);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || submitting.current) return;
        setHostError(null);
        setPortError(null);
        setCodeError(null);
        setFormError(null);

        // 整段粘贴的配对链接（`pi2://pair?…` / `…/pair/CODE`）先拆成地址 + 端口 + 配对码，
        // 拆不出内容时留在链接输入框上报错。
        const pastedLink = parsePairLink(link) ?? parsePairLink(host);
        if (link.trim() && !parsePairLink(link)) {
            setLinkError(t("connect.invalidLink"));
            return;
        }
        setLinkError(null);
        const hostValue = pastedLink ? pastedLink.hostname : host;
        const portValue = pastedLink ? String(pastedLink.port) : port;
        const codeValue = pastedLink ? pastedLink.code : code;
        if (pastedLink) {
            setHost(pastedLink.hostname);
            setPort(String(pastedLink.port));
            setCode(pastedLink.code);
        }

        const parsed = parseEndpoint(hostValue, portValue);
        if ("error" in parsed) {
            if (parsed.error === "host") {
                setHostError(t("connect.hostRequired"));
                hostInputRef.current?.focus();
                return;
            }
            if (parsed.error === "port") {
                setPortError(t("connect.portInvalid"));
                return;
            }
            const message = t("connect.failed");
            setFormError(message);
            toast.error(message);
            return;
        }

        const normalized = normalizePairCode(codeValue);
        if (!normalized) {
            setCodeError(t("connect.pairCodeRequired"));
            return;
        }
        if (!isPairCode(normalized)) {
            setCodeError(t("connect.pairCodeInvalid"));
            return;
        }

        submitting.current = true;
        setBusy(true);
        try {
            await onConnect({
                endpoint: parsed.endpoint,
                code: normalized,
                deviceName: deviceName.trim() || defaultDeviceName,
            });
        } catch (error) {
            const message = t(pairErrorMessage(error));
            setFormError(message);
            toast.error(message);
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }

    return (
        <div className="cn-manual" id={formId} hidden={!expanded} data-testid="connect-manual-panel">
            <form className="cn-form" noValidate onSubmit={(event) => void submit(event)}>
                <Field
                    label={t("connect.pairingLink")}
                    htmlFor={`${id}-link`}
                    hint={t("connect.pasteHint", { defaultValue: "Paste the link from the QR code" })}
                    error={linkError}
                >
                    <Input
                        id={`${id}-link`}
                        data-testid="connect-link"
                        type="text"
                        inputMode="url"
                        autoCapitalize="off"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t("connect.pastePlaceholder")}
                        value={link}
                        onChange={(event) => {
                            const text = event.target.value;
                            setLink(text);
                            setLinkError(null);
                            // 能解析就立即回填，用户只需再按一次连接。
                            const target = parsePairLink(text);
                            if (!target) return;
                            setHost(target.hostname);
                            setPort(String(target.port));
                            setCode(target.code);
                            portEdited.current = true;
                            setHostError(null);
                            setPortError(null);
                            setCodeError(null);
                        }}
                    />
                </Field>

                <div className="cn-row">
                    <Field label={t("connect.host")} htmlFor={`${id}-host`} error={hostError}>
                        <Input
                            ref={hostInputRef}
                            id={`${id}-host`}
                            data-testid="connect-host"
                            type="text"
                            inputMode="url"
                            autoCapitalize="off"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={t("connect.hostPlaceholder")}
                            value={host}
                            onChange={(event) => {
                                setHost(event.target.value);
                                setHostError(null);
                            }}
                        />
                    </Field>
                    <Field label={t("connect.port")} htmlFor={`${id}-port`} error={portError}>
                        <Input
                            id={`${id}-port`}
                            data-testid="connect-port"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder={defaultPort || undefined}
                            value={port}
                            onChange={(event) => {
                                setPort(event.target.value);
                                portEdited.current = true;
                                setPortError(null);
                            }}
                        />
                    </Field>
                </div>

                <Field
                    label={t("connect.pairCode")}
                    htmlFor={`${id}-pair-code`}
                    hint={t("connect.pairCodeHint")}
                    error={codeError}
                >
                    <Input
                        id={`${id}-pair-code`}
                        data-testid="connect-pair-code"
                        className="cn-code"
                        type="text"
                        inputMode="text"
                        autoCapitalize="characters"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={PAIR_CODE_LENGTH}
                        placeholder={t("connect.pairCodePlaceholder")}
                        value={code}
                        onChange={(event) => {
                            setCode(normalizePairCode(event.target.value).slice(0, PAIR_CODE_LENGTH));
                            setCodeError(null);
                        }}
                    />
                </Field>

                <Field label={t("connect.deviceName")} htmlFor={`${id}-device`} hint={t("common.optional")}>
                    <Input
                        id={`${id}-device`}
                        data-testid="connect-device"
                        type="text"
                        autoComplete="nickname"
                        placeholder={t("connect.deviceNamePlaceholder")}
                        value={deviceName}
                        onChange={(event) => setDeviceName(event.target.value)}
                    />
                </Field>

                {formError ? (
                    <div className="cn-error" role="alert">
                        <span className="cn-ico">
                            <Icon name="alert" />
                        </span>
                        <span>{formError}</span>
                    </div>
                ) : null}

                <div className="cn-form__foot">
                    <Button
                        variant={primary ? "primary" : "default"}
                        type="submit"
                        className="cn-submit"
                        disabled={busy}
                        data-testid="connect-submit"
                    >
                        <Icon name={busy ? "refresh" : "chevron-right"} />
                        {busy ? t("connect.connecting") : t("connect.connect")}
                    </Button>
                </div>
            </form>
        </div>
    );
}
