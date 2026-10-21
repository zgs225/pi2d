import type { AttentionItem } from "@protocol/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { setLanguage } from "@/lib/i18n";
import { AttentionDialog } from "@/features/chat/attention";
import { sessionFixture } from "./chat-fixtures";

beforeAll(async () => {
    await setLanguage("en");
});

function attention(overrides: Partial<AttentionItem> = {}): AttentionItem {
    return {
        requestId: "att-1",
        method: "select",
        title: "Run this command?",
        message: "Allow the pending tool call",
        options: [
            { id: "allow-once", label: "Allow once" },
            { id: "deny", label: "Deny" },
        ],
        timeoutSec: 10,
        createdAt: Date.now(),
        receivedAt: Date.now(),
        ...overrides,
    };
}

describe("attention dialog", () => {
    it("renders the server title/options and answers `select` with the option id", async () => {
        const item = attention();
        const onRespond = vi.fn();
        render(
            <AttentionDialog
                session={sessionFixture({ attention: [item] })}
                onRespond={onRespond}
                onRemoteResolved={vi.fn()}
            />,
        );

        expect(await screen.findByText("Run this command?")).toBeInTheDocument();
        const option = screen.getByRole("button", { name: "Allow once" });
        expect(option).toHaveAttribute("data-option-id", "allow-once");

        fireEvent.click(option);
        // `pi.attention.resolve` expects `{value: <option id>}`.
        expect(onRespond).toHaveBeenCalledWith(item, { value: "allow-once" });
    });

    it("answers `confirm` with `{confirmed}` and cancels with `{cancelled}`", async () => {
        const item = attention({ method: "confirm", options: undefined, title: "Proceed?" });
        const onRespond = vi.fn();
        render(
            <AttentionDialog
                session={sessionFixture({ attention: [item] })}
                onRespond={onRespond}
                onRemoteResolved={vi.fn()}
            />,
        );

        expect(await screen.findByText("Proceed?")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        expect(onRespond).toHaveBeenLastCalledWith(item, { confirmed: true });

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onRespond).toHaveBeenLastCalledWith(item, { cancelled: true });
    });

    it("closes and reports when another client resolves the request", async () => {
        const item = attention();
        const onRemoteResolved = vi.fn();
        const { rerender } = render(
            <AttentionDialog
                session={sessionFixture({ attention: [item] })}
                onRespond={vi.fn()}
                onRemoteResolved={onRemoteResolved}
            />,
        );
        expect(await screen.findByText("Run this command?")).toBeInTheDocument();
        expect(onRemoteResolved).not.toHaveBeenCalled();

        // `pi2:attention_resolved` drops the request from `session.attention`.
        rerender(
            <AttentionDialog
                session={sessionFixture({ attention: [] })}
                onRespond={vi.fn()}
                onRemoteResolved={onRemoteResolved}
            />,
        );
        await waitFor(() => expect(onRemoteResolved).toHaveBeenCalledWith("att-1"));
    });

    it("closes itself when the server timeout has elapsed", async () => {
        const item = attention({ timeoutSec: 1, receivedAt: Date.now() - 5_000 });
        render(
            <AttentionDialog
                session={sessionFixture({ attention: [item] })}
                onRespond={vi.fn()}
                onRemoteResolved={vi.fn()}
            />,
        );

        await waitFor(() => expect(screen.queryByText("Run this command?")).not.toBeInTheDocument());
    });

    it("renders the diff review variant and sends the plugin's review JSON", async () => {
        const item = attention({
            method: "diff",
            title: "Review the edit",
            payload: {
                files: [{ path: "src/auth.ts", before: "const a = 1;\n", after: "const a = 2;\n" }],
            },
        });
        const onRespond = vi.fn();
        render(
            <AttentionDialog
                session={sessionFixture({ attention: [item] })}
                onRespond={onRespond}
                onRemoteResolved={vi.fn()}
            />,
        );

        expect(await screen.findByText("src/auth.ts")).toBeInTheDocument();
        const acceptAll = screen.getByRole("button", { name: "Accept all" });
        expect(acceptAll).toHaveAttribute("data-decision", "accept");

        fireEvent.click(acceptAll);
        expect(onRespond).toHaveBeenCalledTimes(1);
        // The plugin decodes `response.value` as JSON: `{result, path?}`.
        const response = onRespond.mock.calls[0]?.[1];
        expect(response).toHaveProperty("value");
        expect(JSON.parse(String((response as { value: string }).value))).toEqual({ result: "Accepted" });
    });

    it("carries the reviewed path on per-file diff decisions", async () => {
        const item = attention({
            method: "diff",
            title: "Review the edit",
            payload: {
                files: [{ path: "src/auth.ts", before: "a\n", after: "b\n" }],
            },
        });
        const onRespond = vi.fn();
        render(
            <AttentionDialog
                session={sessionFixture({ attention: [item] })}
                onRespond={onRespond}
                onRemoteResolved={vi.fn()}
            />,
        );

        expect(await screen.findByText("src/auth.ts")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Reject" }));
        const answer = onRespond.mock.calls[0]?.[1] as { value: string };
        expect(JSON.parse(answer.value)).toEqual({ result: "Rejected", path: "src/auth.ts" });
    });
});
