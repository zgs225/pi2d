import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SubagentModal, TaskOutputModal } from "@/features/chat/modals";
import { setLanguage } from "@/lib/i18n";

import { sessionFixture, subagentFixture, taskFixture, taskOutputFixture } from "./chat-fixtures";
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

describe("subagent preview modal", () => {
    it("renders the raw pi entries from subagent.read (sessionFile + lines)", async () => {
        mockCommands({
            "subagent.read": {
                status: 202,
                body: {
                    sessionFile: "/tmp/pi2-subsessions/researcher.jsonl",
                    lines: ["[1] user: fix the auth flow", "[2] assistant: looking at it now", "[3] tool result: ok"],
                },
            },
        });

        render(
            <SubagentModal
                open
                session={sessionFixture()}
                subagent={subagentFixture()}
                onClose={vi.fn()}
                onBack={vi.fn()}
                onSteer={vi.fn()}
            />,
        );

        expect(await screen.findByText("fix the auth flow")).toBeInTheDocument();
        expect(screen.getByText("looking at it now")).toBeInTheDocument();
        expect(screen.getByText("/tmp/pi2-subsessions/researcher.jsonl")).toBeInTheDocument();
        expect(screen.getByText("fix the auth flow").closest("article")).toHaveAttribute("data-role", "user");
        expect(screen.getByText("looking at it now").closest("article")).toHaveAttribute("data-role", "assistant");
        // No synthetic "preview" copy.
        expect(screen.queryByText(/Got it\. I'll run with/)).not.toBeInTheDocument();
    });

    it("shows an error state when the sub-session cannot be read", async () => {
        mockCommands({
            "subagent.read": {
                status: 404,
                body: { error: { code: "E_NOT_FOUND", message: "unknown sub-agent session file", retryable: false } },
            },
        });
        render(
            <SubagentModal
                open
                session={sessionFixture()}
                subagent={subagentFixture()}
                onClose={vi.fn()}
                onBack={vi.fn()}
                onSteer={vi.fn()}
            />,
        );

        expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
    });
});
