/**
 * Shared body slot + hover-only action strip.
 *
 * `ToolOps` is the one action area of a tool: it lives in the row (`.tool__row`) and
 * is only visible on hover / `:focus-within` (`.tool__ops`, tool-core.css). A family
 * with no actions renders nothing at all (`hidden`), so successful rows carry no
 * button group at rest.
 *
 * `ToolBody` is the lazily populated `.tool__body`: the wrapper always exists so
 * `aria-controls` resolves, but the family body is only rendered after the first
 * expand, and a throwing body degrades to `.tool-empty` instead of breaking the
 * message stream.
 */
import { Component, createElement, useState } from "react";
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import { tr } from "./format";
import { kindOf } from "./kind";
import { specFor } from "./registry";
import type { ToolBodyProps, ToolSpec } from "./types";

/** Shared footer for bodies with a fold or a secondary action (`.tool__foot`). */
export function ToolFoot({ children }: { children: ReactNode }) {
    return <div className="tool__foot">{children}</div>;
}

/**
 * Shared error row (`.tool__error`): one line, `role=alert`; past 160 chars it becomes a
 * focusable `role=button` that toggles the full text (prototype `core.js:355-374`).
 */
export function ToolError({ text }: { text: string }) {
    const [full, setFull] = useState(false);
    const long = text.length > 160;
    const short = long ? `${text.slice(0, 157)}…` : text;
    const toggle = () => setFull((value) => !value);

    return (
        <div
            className="tool__error"
            role={long ? "button" : "alert"}
            tabIndex={long ? 0 : undefined}
            onClick={long ? toggle : undefined}
            onKeyDown={
                long
                    ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              toggle();
                          }
                      }
                    : undefined
            }
        >
            <span className="tool__error-ico" aria-hidden="true">
                <TriangleAlert size={12} strokeWidth={2} />
            </span>
            <span className="tool__error-text">{full ? text : short}</span>
        </div>
    );
}

/** Row actions — hover / focus-visible only. */
export function ToolOps({ tool, ctx, spec }: ToolBodyProps & { spec?: ToolSpec }) {
    const { t } = useTranslation();
    const resolved = spec ?? specFor(tool.kind ?? kindOf(tool.name));
    const actions = (resolved.actions ? resolved.actions(tool, ctx) : []).filter(Boolean);

    return (
        <span className="tool__ops" hidden={actions.length === 0}>
            {actions.map((action, index) => {
                const ActionIcon = action.icon;
                const label = t(action.labelKey);
                return (
                    <Button
                        variant="ghost"
                        size="icon"
                        className={action.danger ? "tool__op is-danger" : "tool__op"}
                        aria-label={label}
                        title={label}
                        key={`${action.labelKey}-${index}`}
                        onClick={action.onAction}
                    >
                        <ActionIcon size={13} strokeWidth={1.75} aria-hidden />
                    </Button>
                );
            })}
        </span>
    );
}

class BodyBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
    state: { failed: string | null } = { failed: null };

    static getDerivedStateFromError(error: unknown): { failed: string } {
        return { failed: String((error as Error)?.message ?? error) };
    }

    render(): ReactNode {
        if (this.state.failed !== null) return <div className="tool-empty">{this.state.failed}</div>;
        return this.props.children;
    }
}

export interface ToolBodySlotProps extends ToolBodyProps {
    spec: ToolSpec;
    id: string;
    hidden: boolean;
    /** False until the row is opened once — keeps the body genuinely lazy. */
    mounted: boolean;
}

export function ToolBody({ tool, ctx, spec, id, hidden, mounted }: ToolBodySlotProps) {
    const Body = spec.Body;
    return (
        <div className="tool__body" id={id} hidden={hidden}>
            {!mounted ? null : Body ? (
                <BodyBoundary>
                    {createElement(Body, { tool, ctx })}
                </BodyBoundary>
            ) : (
                <div className="tool-empty">{tr("chat.meta.noOutput")}</div>
            )}
        </div>
    );
}
