import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolRow } from "@/features/chat/tools/tool-row";
import type { ToolView } from "@/features/chat/tools/types";
import en from "@/locales/en.json";

/** jsdom runs with an en browser, so the merged catalog resolves to these values. */
function t(key: string): string {
    const value = (en as Record<string, string>)[key];
    if (!value) throw new Error(`missing catalog key ${key}`);
    return value;
}

function tool(overrides: Partial<ToolView> = {}): ToolView {
    return { id: "t1", messageId: "m1", name: "bash", input: { command: "pnpm test" }, ...overrides };
}

function head(container: HTMLElement, index = 0): HTMLElement {
    const node = container.querySelectorAll(".tool__head")[index];
    if (!node) throw new Error(`missing .tool__head #${index}`);
    return node as HTMLElement;
}

describe("ToolRow — anatomy", () => {
    it("renders exactly one row with state glyph, family icon, verb, target, facts and caret", () => {
        const { container } = render(<ToolRow tool={tool()} />);
        const root = container.querySelector(".tool");
        expect(container.querySelectorAll(".tool")).toHaveLength(1);
        expect(root).toHaveClass("tool--shell", "tool--done");
        expect(root?.getAttribute("data-tool")).toBe("bash");
        expect(root?.getAttribute("data-kind")).toBe("shell");
        expect(root?.getAttribute("data-state")).toBe("done");

        const button = head(container);
        expect(button.tagName).toBe("BUTTON");
        expect(button.querySelector(".tool__state .tool__state-ico")).toBeTruthy();
        expect(button.querySelector(".tool__icon svg")).toBeTruthy();
        expect(button.querySelector(".tool__verb")?.textContent).toBe(t("chat.tv.shell.done"));
        expect(button.querySelector(".tool__target")?.textContent).toBe("pnpm test");
        expect(button.querySelector(".tool__caret")).toBeTruthy();
    });

    it("wires aria-expanded to aria-controls / the body id", () => {
        const { container } = render(<ToolRow tool={tool()} />);
        const button = head(container);
        const body = container.querySelector(".tool__body") as HTMLElement;
        expect(button.getAttribute("aria-expanded")).toBe("false");
        expect(button.getAttribute("aria-controls")).toBe(body.id);
        expect(body).toHaveAttribute("hidden");
    });

    it("uses the completed tense for queued rows and keeps the spinner for running only", () => {
        const { container, rerender } = render(<ToolRow tool={tool({ state: "running", startedAt: Date.now() })} />);
        expect(container.querySelector(".spinner")).toBeTruthy();
        expect(container.querySelector(".tool__verb")?.textContent).toBe(t("chat.tv.shell.running"));

        rerender(<ToolRow tool={tool({ state: "queued" })} />);
        expect(container.querySelector(".spinner")).toBeNull();
        expect(container.querySelector(".tool__verb")?.textContent).toBe(t("chat.tv.shell.done"));
        expect(container.querySelector(".tool__state-ico")).toHaveClass("is-queued");
    });

    it("shows a duration only for calls at or above one second", () => {
        const { container, rerender } = render(<ToolRow tool={tool({ durationMs: 400 })} />);
        expect(container.querySelector(".tool__dur")?.textContent).toBe("");
        rerender(<ToolRow tool={tool({ durationMs: 1500 })} />);
        expect(container.querySelector(".tool__dur")?.textContent).toBe("1.5s");
    });

    it("caps facts at three and separates them with a middle dot", () => {
        const { container } = render(
            <ToolRow
                tool={tool({
                    name: "mcp__slack__post",
                    input: undefined,
                    meta: { lines: 3, matches: 2, files: 1, entries: 4, images: 5 },
                })}
            />,
        );
        const facts = container.querySelectorAll(".tool__meta .tool__fact");
        expect(facts).toHaveLength(3);
        expect(container.querySelectorAll(".tool__meta .tsep")).toHaveLength(2);
    });

    it("renders stat and tag facts for the write family", () => {
        const { container } = render(
            <ToolRow
                tool={tool({
                    name: "edit",
                    input: { path: "a.ts" },
                    meta: { added: 2, removed: 1, newFile: true },
                })}
            />,
        );
        expect(container.querySelector(".tool__meta .tool__stat .is-add")).toBeTruthy();
        expect(container.querySelector(".tool__meta .tool__stat .is-del")).toBeTruthy();
        expect(container.querySelector(".tool__meta .badge")).toBeTruthy();
    });
});

describe("ToolRow — inline and body laziness", () => {
    it("renders `read` as a plain div head without caret, aria-expanded or body", () => {
        const { container } = render(
            <ToolRow tool={tool({ name: "read", input: { path: "src/a.ts", offset: 10, limit: 5 } })} />,
        );
        const button = head(container);
        expect(button.tagName).toBe("DIV");
        expect(button.getAttribute("aria-expanded")).toBeNull();
        expect(button.getAttribute("aria-controls")).toBeNull();
        expect(container.querySelector(".tool__caret")).toBeNull();
        expect(container.querySelector(".tool__body")).toBeNull();
        expect(button.querySelector(".tool__target")?.textContent).toBe("src/a.ts:10–14");
    });

    it("mounts the body on the first expand only and keeps it on collapse", () => {
        const { container } = render(<ToolRow tool={tool({ name: "mcp__slack__post", input: { channel: "x" } })} />);
        const button = head(container);
        const body = container.querySelector(".tool__body") as HTMLElement;
        expect(container.querySelector(".generic__body")).toBeNull();

        fireEvent.click(button);
        expect(button.getAttribute("aria-expanded")).toBe("true");
        expect(body).not.toHaveAttribute("hidden");
        expect(container.querySelector(".generic__body")).toBeTruthy();

        fireEvent.click(button);
        expect(button.getAttribute("aria-expanded")).toBe("false");
        expect(body).toHaveAttribute("hidden");
        // Collapsing does not unmount: the family body keeps its local fold state.
        expect(container.querySelector(".generic__body")).toBeTruthy();
    });

    it("honours defaultOpen", () => {
        const { container } = render(<ToolRow tool={tool({ name: "grep", input: { pattern: "needle" } })} defaultOpen />);
        expect(head(container).getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelector(".tool__body")).not.toHaveAttribute("hidden");
        expect(container.querySelector(".search__empty")).toBeTruthy();
    });
});

describe("ToolRow — expansion is local", () => {
    it("does not recreate sibling rows and keeps aria-expanded in sync", () => {
        const { container } = render(
            <div>
                <ToolRow tool={tool({ id: "a", messageId: "ma" })} />
                <ToolRow tool={tool({ id: "b", messageId: "mb", name: "grep", input: { pattern: "x" } })} />
            </div>,
        );
        const siblings = Array.from(container.querySelectorAll(".tool"));
        const second = siblings[1];

        fireEvent.click(head(container, 0));

        const after = Array.from(container.querySelectorAll(".tool"));
        expect(after[1]).toBe(second);
        expect(head(container, 0).getAttribute("aria-expanded")).toBe("true");
        expect(head(container, 1).getAttribute("aria-expanded")).toBe("false");
    });
});

describe("ToolRow — error line", () => {
    it("explains hard failures and marks the verb as an error", () => {
        const { container } = render(<ToolRow tool={tool({ state: "failed", result: { error: "exit 1" } })} />);
        const row = container.querySelector(".tool__error");
        expect(row).toBeTruthy();
        expect(row?.getAttribute("role")).toBe("alert");
        expect(row?.textContent).toContain("exit 1");
        expect(container.querySelector(".tool__verb")).toHaveClass("is-err");
    });

    it("falls back to the first output line for hard failures without an explicit error", () => {
        const { container } = render(<ToolRow tool={tool({ state: "error", text: { lines: ["command not found"] } })} />);
        expect(container.querySelector(".tool__error")?.textContent).toContain("command not found");
    });

    it("stays quiet for soft states without an explicit reason", () => {
        const { container } = render(<ToolRow tool={tool({ state: "cancelled", text: { lines: ["normal output"] } })} />);
        expect(container.querySelector(".tool__error")).toBeNull();
    });

    it("shows a soft state error only when the tool gave a reason", () => {
        const { container } = render(
            <ToolRow tool={tool({ state: "interrupted", result: { error: "user aborted" } })} />,
        );
        expect(container.querySelector(".tool__error")?.textContent).toContain("user aborted");
    });

    it("folds very long errors behind a focusable role=button toggle", () => {
        const long = `${"x".repeat(200)}TAIL`;
        const { container } = render(<ToolRow tool={tool({ state: "failed", result: { error: long } })} />);
        const row = container.querySelector(".tool__error") as HTMLElement;
        expect(row.getAttribute("role")).toBe("button");
        expect(row.getAttribute("tabindex")).toBe("0");
        expect(row.textContent).not.toContain("TAIL");
        fireEvent.click(row);
        expect(row.textContent).toContain("TAIL");
    });

    it("degrades unknown states to done and never renders an error row", () => {
        const { container } = render(<ToolRow tool={tool({ state: "exploded" })} />);
        expect(container.querySelector(".tool")?.getAttribute("data-state")).toBe("done");
        expect(container.querySelector(".tool__error")).toBeNull();
    });
});

describe("ToolRow — success rows stay quiet", () => {
    it("has no footer, no error row and no visible action group when the family has no actions", () => {
        const { container } = render(<ToolRow tool={tool({ name: "mcp__x__y", input: { a: 1 } })} />);
        expect(container.querySelector(".tool__foot")).toBeNull();
        expect(container.querySelector(".tool__error")).toBeNull();
        expect(container.querySelector(".tool__ops")).toHaveAttribute("hidden");
    });

    it("exposes the copy-path action for inline read rows", () => {
        const { container } = render(<ToolRow tool={tool({ name: "read", input: { path: "a.ts" } })} />);
        const ops = container.querySelector(".tool__ops") as HTMLElement;
        expect(ops).not.toHaveAttribute("hidden");
        const action = ops.querySelector("button");
        expect(action?.getAttribute("aria-label")).toBe(t("chat.meta.copyPath"));
        expect(container.querySelector(".tool__foot")).toBeNull();
    });
});

describe("ToolRow — every registered kind renders", () => {
    const CASES: ToolView[] = [
        { id: "1", name: "bash", input: { command: "ls -la" }, text: { lines: ["a"] } },
        { id: "2", name: "task", input: { command: "build", taskId: "t-1" }, result: { taskId: "t-1" } },
        { id: "3", name: "read", input: { path: "a.ts" } },
        {
            id: "4",
            name: "edit",
            input: { path: "a.ts", oldText: "a", newText: "b" },
            diff: {
                files: [
                    {
                        path: "a.ts",
                        status: "modified",
                        added: 1,
                        removed: 1,
                        hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [{ t: "del", old: 1, new: null, text: "a" }, { t: "add", old: null, new: 1, text: "b" }] }],
                    },
                ],
            },
        },
        { id: "5", name: "grep", input: { pattern: "foo" }, matches: [{ path: "a.ts", line: 3, col: 1, text: "foo bar" }] },
        { id: "6", name: "find", input: { pattern: "*.ts" }, files: ["src/a.ts", "src/b.ts", "docs/c.md"] },
        { id: "7", name: "web_search", input: { query: "q" } },
        { id: "8", name: "vision", input: { path: "i.png" } },
        { id: "9", name: "todo_write", todos: [{ content: "x", status: "pending" }] },
        { id: "10", name: "dispatch_subagents", input: { mode: "dispatch" }, batch: { items: [] } },
        { id: "11", name: "mcp__x__y", input: { a: 1 }, result: { ok: true } },
    ];

    it("covers 11 kinds, opens the body and keeps one row each", () => {
        expect(CASES).toHaveLength(11);
        const kinds = new Set<string>();
        for (const item of CASES) {
            const { container, unmount } = render(<ToolRow tool={item} defaultOpen />);
            expect(container.querySelectorAll(".tool")).toHaveLength(1);
            const kind = container.querySelector(".tool")?.getAttribute("data-kind") ?? "";
            kinds.add(kind);
            expect(container.querySelectorAll(".tool__head")).toHaveLength(1);
            unmount();
        }
        expect(kinds.size).toBe(11);
    });
});
