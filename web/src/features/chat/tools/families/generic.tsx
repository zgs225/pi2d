/**
 * `generic` — unregistered tools and MCP calls (`mcp__server__tool`).
 *
 * Contract §4.11: never blank, never throws. Two `.ts` sections (input / result);
 * every value renders as JSON with a 24-line budget and a counted fold, empty
 * values render `chat.meta.noOutput`.
 */
import "@/styles/tool-generic.css";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import { firstLine, tpNum } from "../format";
import { KIND_ICON, humanName } from "../kind";
import { isFailure, stateOf } from "../state";
import type { ToolBodyProps, ToolSpec, ToolView } from "../types";
import { ToolFoot } from "../tool-body";

/** `jsonBlock` fold budget (prototype `core.js:260-275`). */
const JSON_LINES = 24;

function isEmptyValue(value: unknown): boolean {
    if (value == null) return true;
    if (typeof value === "string") return value.trim() === "";
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
    return false;
}

function jsonText(value: unknown): string {
    try {
        const text = JSON.stringify(value, null, 2);
        return text == null ? String(value) : text;
    } catch {
        return String(value);
    }
}

/** JSON block with a 24-line budget; the fold always reports how many lines are hidden. */
function JsonBlock({ value }: { value: unknown }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const text = jsonText(value);
    const lines = text.split("\n");
    const omitted = Math.max(0, lines.length - JSON_LINES);
    const shown = expanded || omitted === 0 ? text : `${lines.slice(0, JSON_LINES).join("\n")}\n…`;

    return (
        <div className="tool-json">
            <pre className="mono tool__pre tool__pre--json">{shown}</pre>
            {expanded || omitted === 0 ? null : (
                <ToolFoot>
                    <span className="tool__foot-count tabular">{tpNum("chat.meta.omitted", omitted)}</span>
                    <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                        {t("chat.meta.showAll")}
                    </Button>
                </ToolFoot>
            )}
        </div>
    );
}

function Section({ titleKey, value }: { titleKey: string; value: unknown }) {
    const { t } = useTranslation();
    return (
        <section className="ts generic__section">
            <h4 className="ts__title">{t(titleKey)}</h4>
            {isEmptyValue(value) ? (
                <div className="tool-empty">{t("chat.meta.noOutput")}</div>
            ) : (
                <JsonBlock value={value} />
            )}
        </section>
    );
}

function GenericBody({ tool }: ToolBodyProps) {
    // Legacy DTOs carry a bare `raw` args value instead of a structured `input`.
    const input = tool.input ?? tool.raw;
    return (
        <div className="generic__body">
            <Section titleKey="chat.meta.input" value={input} />
            <Section titleKey="chat.meta.result" value={tool.result} />
        </div>
    );
}

/** Failure phrase: explicit `result.error` / `stderr`, else first output line on hard failure. */
function errorOf(tool: ToolView): string | null {
    const explicit = tool.result?.error || tool.result?.stderr;
    const first = tool.text?.lines?.[0] ?? null;
    const raw = explicit || (isFailure(stateOf(tool)) ? first : null);
    if (raw == null || raw === "") return null;
    return firstLine(raw);
}

export const genericSpec: ToolSpec = {
    id: "generic",
    icon: KIND_ICON.generic,
    verb: "generic",
    target: (tool) => humanName(tool.name),
    error: errorOf,
    Body: (props) => <GenericBody {...props} />,
};
