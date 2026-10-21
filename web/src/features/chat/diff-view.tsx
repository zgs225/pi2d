import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DiffFile } from "./diff";

export interface DiffViewProps {
    files: DiffFile[];
    /** When provided, render per-file + accept-all/reject-all actions. */
    onDecision?: (decision: "accept" | "reject", path?: string) => void;
    className?: string;
}

/** Unified diff accordion (tool cards + pre-execution attention review). */
export function DiffView({ files, onDecision, className }: DiffViewProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState<Record<string, boolean>>(() => {
        const initial: Record<string, boolean> = {};
        files.forEach((file, index) => {
            initial[file.path] = index === 0;
        });
        return initial;
    });

    if (!files.length) return null;

    return (
        <div className={cn("diff", className)}>
            {files.map((file) => {
                const expanded = open[file.path] ?? false;
                return (
                    <div key={file.path} className={cn("diff__file", expanded && "open")}>
                        <button
                            type="button"
                            className="diff__head"
                            aria-expanded={expanded}
                            onClick={() => setOpen((current) => ({ ...current, [file.path]: !expanded }))}
                        >
                            <span className="diff__caret">
                                <Icon name="chevron-right" />
                            </span>
                            <Icon name="file" />
                            <span className="truncate grow mono">{file.path}</span>
                            <span className="diff__stat">
                                {`+${file.add} −${file.del}`}
                            </span>
                        </button>
                        {expanded ? (
                            <div className="diff__body">
                                {file.hunks.length ? (
                                    file.hunks.map((hunk, hunkIndex) => (
                                        <div className="diff__hunk" key={`${file.path}-${hunkIndex}`}>
                                            {hunk.header ? <div className="diff__hunkhead">{hunk.header}</div> : null}
                                            {hunk.lines.map((line, lineIndex) => {
                                                const kind = line.startsWith("+")
                                                    ? "add"
                                                    : line.startsWith("-")
                                                      ? "del"
                                                      : "ctx";
                                                return (
                                                    <span
                                                        key={`${hunkIndex}-${lineIndex}`}
                                                        className={cn(
                                                            "diff__line",
                                                            kind === "add" && "diff__line--add",
                                                            kind === "del" && "diff__line--del",
                                                        )}
                                                    >
                                                        {line}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    ))
                                ) : (
                                    <div className="diff__empty muted">{t("chat.noChanges")}</div>
                                )}
                                {onDecision ? (
                                    <div className="diff__foot">
                                        <span className="muted grow">
                                            {t("chat.source", { name: file.source ?? t("chat.parentSession") })}
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            data-decision="accept"
                                            data-path={file.path}
                                            onClick={() => onDecision("accept", file.path)}
                                        >
                                            {t("chat.accept")}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="danger"
                                            data-decision="reject"
                                            data-path={file.path}
                                            onClick={() => onDecision("reject", file.path)}
                                        >
                                            {t("chat.reject")}
                                        </Button>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}
            {onDecision ? (
                <div className="diff__foot diff__foot--all">
                    <span className="muted grow">{t("chat.diffReview")}</span>
                    <Button
                        size="sm"
                        variant="ghost"
                        data-decision="reject"
                        onClick={() => onDecision("reject")}
                    >
                        {t("chat.rejectAll")}
                    </Button>
                    <Button
                        size="sm"
                        variant="primary"
                        data-decision="accept"
                        onClick={() => onDecision("accept")}
                    >
                        {t("chat.acceptAll")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
