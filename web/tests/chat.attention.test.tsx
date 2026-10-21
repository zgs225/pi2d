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
    it("renders the request and responds with the chosen option", async () => {
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
        fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
        expect(onRespond).toHaveBeenCalledWith(item, "allow-once");
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

        rerender(
            <AttentionDialog
                session={sessionFixture({ attention: [] })}
                onRespond={vi.fn()}
                onRemoteResolved={onRemoteResolved}
            />,
        );
        await waitFor(() => expect(onRemoteResolved).toHaveBeenCalledWith("att-1"));
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
        fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
        expect(onRespond).toHaveBeenCalledTimes(1);
        const response = onRespond.mock.calls[0]?.[1];
        expect(typeof response).toBe("string");
        expect(JSON.parse(String(response))).toEqual({ result: "Accepted" });
    });
});
