import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TaskOutputModal } from "@/features/chat/modals";
import { setLanguage } from "@/lib/i18n";

import { sessionFixture, taskFixture, taskOutputFixture } from "./chat-fixtures";
import { mockApi } from "./helpers/api-mock";

beforeAll(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Answer `/api/v1/cmd` from a per-method table (the real plugin ack payloads). */
function mockCommands(replies: Record<string, { status?: number; body: unknown }>) {
    return mockApi([
        {
            method: "POST",
            path: "/api/v1/cmd",
            handler: ({ body }) => {
                const method = (body as { method?: string } | undefined)?.method ?? "";
                const reply = replies[method];
                if (!reply) return { status: 202, body: { accepted: true } };
                return reply;
            },
        },
    ]);
}

describe("task output modal", () => {
    it("renders the real task.output payload instead of a fake pid", async () => {
        const fetchMock = mockCommands({ "task.output": { status: 202, body: taskOutputFixture() } });
        render(
            <TaskOutputModal
                open
                session={sessionFixture()}
                task={taskFixture()}
                onClose={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        expect(await screen.findByText(/42 passed/)).toBeInTheDocument();
        // The mock-era pseudo pid is gone.
        expect(screen.queryByText("pid")).not.toBeInTheDocument();
        expect(screen.getAllByText("/tmp/pi2-task-t1.log").length).toBeGreaterThan(0);
        expect(screen.getByText("exit code")).toBeInTheDocument();
        expect(screen.getByText("0")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
            method: "task.output",
            params: { taskId: "t1" },
        });
    });

    it("shows a real error state when the plugin does not support the command", async () => {
        mockCommands({
            "task.output": {
                status: 501,
                body: { error: { code: "E_UNSUPPORTED", message: "unknown method: task.output", retryable: false } },
            },
        });
        render(
            <TaskOutputModal
                open
                session={sessionFixture()}
                task={taskFixture()}
                onClose={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        expect(await screen.findByText(/Unsupported operation/)).toBeInTheDocument();
        expect(screen.queryByText("(no output)")).not.toBeInTheDocument();
    });
});
