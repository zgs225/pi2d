import { useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiError, errorI18nKey } from "@/lib/api";

import { parseEndpoint } from "./pairing";

export interface ManualConnectInput {
    endpoint: string;
    code: string;
    deviceName: string;
}

export interface ManualConnectFormProps {
    onConnect: (input: ManualConnectInput) => Promise<void>;
    hostInputRef: RefObject<HTMLInputElement | null>;
    defaultDeviceName: string;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiError) return errorI18nKey(error.code);
    return fallback;
}

/** Inline manual pairing form: host/port, token-or-code, optional device name. */
export function ManualConnectForm({ onConnect, hostInputRef, defaultDeviceName }: ManualConnectFormProps) {
    const { t } = useTranslation();
    const id = useId();
    const [host, setHost] = useState("");
    const [port, setPort] = useState("4321");
    const [code, setCode] = useState("");
    const [deviceName, setDeviceName] = useState("");
    const [showCode, setShowCode] = useState(false);
    const [hostError, setHostError] = useState<string | null>(null);
    const [portError, setPortError] = useState<string | null>(null);
    const [codeError, setCodeError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || submitting.current) return;
        setHostError(null);
        setPortError(null);
        setCodeError(null);
        setFormError(null);

        const parsed = parseEndpoint(host, port);
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
        if (!code.trim()) {
            setCodeError(t("connect.tokenRequired"));
            return;
        }

        submitting.current = true;
        setBusy(true);
        try {
            await onConnect({
                endpoint: parsed.endpoint,
                code: code.trim(),
                deviceName: deviceName.trim() || defaultDeviceName,
            });
        } catch (error) {
            const message = t(errorMessage(error, "connect.failed"));
            setFormError(message);
            toast.error(message);
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }

    return (
        <section className="card cn-card">
            <h2 className="cn-card__title">
                <span className="cn-ico">
                    <Icon name="server" />
                </span>
                {t("connect.addTitle")}
            </h2>
            <form className="cn-form" noValidate onSubmit={(event) => void submit(event)}>
                <div className="cn-row">
                    <Field label={t("connect.host")} htmlFor={`${id}-host`} error={hostError}>
                        <Input
                            ref={hostInputRef}
                            id={`${id}-host`}
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
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder="4321"
                            value={port}
                            onChange={(event) => {
                                setPort(event.target.value);
                                setPortError(null);
                            }}
                        />
                    </Field>
                </div>

                <Field label={t("connect.token")} htmlFor={`${id}-token`} hint={t("connect.tokenHint")} error={codeError}>
                    <div className="cn-token">
                        <Input
                            id={`${id}-token`}
                            type={showCode ? "text" : "password"}
                            autoComplete="current-password"
                            placeholder={t("connect.tokenPlaceholder")}
                            value={code}
                            onChange={(event) => {
                                setCode(event.target.value);
                                setCodeError(null);
                            }}
                        />
                        <Button
                            variant="ghost"
                            size="icon"
                            className={showCode ? "cn-eye is-on" : "cn-eye"}
                            aria-pressed={showCode}
                            aria-label={t("connect.token")}
                            title={t("connect.token")}
                            onClick={() => setShowCode((value) => !value)}
                        >
                            <Icon name="eye" />
                        </Button>
                    </div>
                </Field>

                <Field label={t("connect.deviceName")} htmlFor={`${id}-device`} hint={t("common.optional")}>
                    <Input
                        id={`${id}-device`}
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
                    <Button variant="primary" type="submit" className="cn-submit" disabled={busy}>
                        <Icon name={busy ? "refresh" : "chevron-right"} />
                        {busy ? t("connect.connecting") : t("connect.connect")}
                    </Button>
                </div>
            </form>
        </section>
    );
}
