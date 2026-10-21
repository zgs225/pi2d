import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { parsePairLink, type PairTarget } from "./pairing";

interface DetectedBarcode {
    rawValue?: string;
}

interface BarcodeDetectorLike {
    detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetectorCtor(): BarcodeDetectorCtor | undefined {
    return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

export interface ScanDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onFound: (target: PairTarget) => void;
    fallbackEndpoint?: string | null;
}

/**
 * Camera preview + BarcodeDetector loop, with the design's paste-link fallback
 * whenever the browser, permission or secure context cannot scan.
 */
export function ScanDialog({ open, onOpenChange, onFound, fallbackEndpoint }: ScanDialogProps) {
    const { t } = useTranslation();
    const [attempt, setAttempt] = useState(0);
    const [live, setLive] = useState(false);
    const [status, setStatus] = useState("");
    const [pasteOpen, setPasteOpen] = useState(false);
    const [paste, setPaste] = useState("");
    const [pasteInvalid, setPasteInvalid] = useState(false);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const detectorRef = useRef<BarcodeDetectorLike | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const finishingRef = useRef(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        finishingRef.current = false;
        setPasteOpen(false);
        setPasteInvalid(false);
        setStatus(t("connect.startingCamera"));

        function stopCamera() {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
            const stream = streamRef.current;
            if (stream) {
                for (const track of stream.getTracks()) track.stop();
                streamRef.current = null;
            }
            detectorRef.current = null;
            if (videoRef.current) videoRef.current.srcObject = null;
            setLive(false);
        }

        function finish(raw: string) {
            const target = parsePairLink(raw, fallbackEndpoint);
            if (!target) {
                setPasteInvalid(true);
                setStatus(t("connect.invalidLink"));
                setPasteOpen(true);
                return;
            }
            if (finishingRef.current) return;
            finishingRef.current = true;
            stopCamera();
            onFound(target);
            onOpenChange(false);
        }

        async function scanFrame() {
            if (cancelled || finishingRef.current) return;
            const detector = detectorRef.current;
            const video = videoRef.current;
            if (!detector || !video) return;
            try {
                const codes = await detector.detect(video);
                const raw = codes[0]?.rawValue;
                if (raw) finish(raw);
            } catch {
                /* a single failed frame should not stop the loop */
            }
        }

        async function startCamera() {
            stopCamera();
            if (!window.isSecureContext) {
                setStatus(t("connect.secureRequired"));
                setPasteOpen(true);
                return;
            }
            if (!navigator.mediaDevices?.getUserMedia) {
                setStatus(t("connect.cameraUnsupported"));
                setPasteOpen(true);
                return;
            }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { ideal: "environment" } },
                });
                if (cancelled) {
                    for (const track of stream.getTracks()) track.stop();
                    return;
                }
                streamRef.current = stream;
                const video = videoRef.current;
                if (video) {
                    video.srcObject = stream;
                    await video.play().catch(() => undefined);
                }
                setLive(true);

                const Ctor = barcodeDetectorCtor();
                if (Ctor) {
                    try {
                        detectorRef.current = new Ctor({ formats: ["qr_code"] });
                    } catch {
                        detectorRef.current = null;
                    }
                }
                if (detectorRef.current) {
                    setStatus(t("connect.aim"));
                    timerRef.current = setInterval(() => void scanFrame(), 300);
                } else {
                    setStatus(t("connect.noAutoDetect"));
                    setPasteOpen(true);
                }
            } catch (error) {
                const denied =
                    error instanceof DOMException &&
                    (error.name === "NotAllowedError" || error.name === "SecurityError");
                setStatus(t(denied ? "connect.permissionDenied" : "connect.cameraFailed"));
                setPasteOpen(true);
            }
        }

        void startCamera();
        return () => {
            cancelled = true;
            stopCamera();
        };
    }, [attempt, fallbackEndpoint, onFound, onOpenChange, open, t]);

    function identify() {
        const target = parsePairLink(paste, fallbackEndpoint);
        if (!target) {
            setPasteInvalid(true);
            setStatus(t("connect.invalidLink"));
            setPasteOpen(true);
            return;
        }
        setPasteInvalid(false);
        onFound(target);
        onOpenChange(false);
    }

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            title={t("connect.scanTitle")}
            size="wide"
            footer={
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    {t("common.close")}
                </Button>
            }
        >
            <div className="cn-scan">
                <div className={live ? "cn-scan__viewport is-live" : "cn-scan__viewport"}>
                    <video
                        ref={videoRef}
                        className="cn-scan__video"
                        autoPlay
                        playsInline
                        muted
                        aria-label={t("connect.cameraPreview")}
                    />
                    <div className="cn-scan__placeholder">
                        <span className="cn-ico">
                            <Icon name="scan" size={28} />
                        </span>
                        <span>{t("connect.cameraPreview")}</span>
                    </div>
                    <div className="cn-scan__frame" aria-hidden="true" />
                </div>
                <div className="cn-scan__state" role="status" aria-live="polite">
                    {status}
                </div>
                <p className="cn-hint">{t("connect.scanHint")}</p>

                <details
                    className="cn-fold"
                    open={pasteOpen}
                    onToggle={(event) => setPasteOpen(event.currentTarget.open)}
                >
                    <summary>{t("connect.cantScan")}</summary>
                    <div className="cn-fold__body">
                        <Input
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            className={pasteInvalid ? "is-invalid" : undefined}
                            placeholder={t("connect.pastePlaceholder")}
                            aria-label={t("connect.pairingLink")}
                            value={paste}
                            onChange={(event) => {
                                setPaste(event.target.value);
                                setPasteInvalid(false);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    identify();
                                }
                            }}
                        />
                        <Button variant="primary" onClick={identify}>
                            {t("connect.identify")}
                        </Button>
                    </div>
                </details>

                <div className="cn-scan__actions">
                    <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                        <Icon name="refresh" />
                        {t("connect.retryCamera")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
