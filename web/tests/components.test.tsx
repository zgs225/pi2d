import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardSub, CardTitle } from "@/components/ui/card";
import { Modal } from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";

describe("Button", () => {
    it("renders the base class and default variant", () => {
        render(<Button>Open</Button>);
        const button = screen.getByRole("button", { name: "Open" });
        expect(button).toHaveClass("btn");
        expect(button).toHaveAttribute("type", "button");
    });

    it("applies variant and size classes", () => {
        render(
            <Button variant="primary" size="sm">
                Save
            </Button>,
        );
        expect(screen.getByRole("button", { name: "Save" })).toHaveClass("btn", "btn--primary", "btn--sm");
    });

    it("supports disabled state", () => {
        render(<Button disabled>Stop</Button>);
        expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    });
});

describe("Card", () => {
    it("renders the card surface with title/sub", () => {
        render(
            <Card>
                <CardTitle>Server info</CardTitle>
                <CardSub>hostname</CardSub>
            </Card>,
        );
        expect(screen.getByText("Server info").closest(".card")).toBeInTheDocument();
        expect(screen.getByText("Server info")).toHaveClass("card__title");
        expect(screen.getByText("hostname")).toHaveClass("card__sub");
    });

    it("renders the hover variant", () => {
        const { container } = render(<Card hover>hover</Card>);
        expect(container.firstElementChild).toHaveClass("card", "card--hover");
    });
});

describe("StatusDot", () => {
    it.each([
        ["busy", "dot--busy"],
        ["compacting", "dot--compacting"],
        ["idle", "dot--idle"],
        ["ok", "dot--ok"],
        ["err", "dot--err"],
        ["attention", "dot--attention"],
        ["exited", "dot--exited"],
    ] as const)("maps %s to %s", (status, expected) => {
        const { container } = render(<StatusDot status={status} />);
        expect(container.firstElementChild).toHaveClass("dot", expected);
    });

    it("exposes the state label when a title is provided", () => {
        render(<StatusDot status="ok" title="Online" />);
        expect(screen.getByLabelText("Online")).toHaveAttribute("title", "Online");
    });
});

describe("Badge", () => {
    it("maps semantic tones", () => {
        const { container } = render(<Badge tone="warn">degraded</Badge>);
        expect(container.firstElementChild).toHaveClass("badge", "badge--warn");
    });
});

describe("Modal", () => {
    function renderModal(onClick = vi.fn()) {
        render(
            <Modal
                open
                onOpenChange={() => undefined}
                title="Confirm connection"
                description="Pairing details"
                footer={
                    <Button variant="primary" onClick={onClick}>
                        Connect now
                    </Button>
                }
            >
                <p>host:port</p>
            </Modal>,
        );
        return onClick;
    }

    it("nests the panel inside the backdrop so the scrim cannot intercept clicks", () => {
        renderModal();
        const dialog = screen.getByRole("dialog");
        expect(dialog).toHaveClass("modal", "modal-content");
        // Sibling content kept painting under `.modal-backdrop` (z-index 60) and
        // Playwright reported "modal-backdrop intercepts pointer events".
        expect(dialog.parentElement).toHaveClass("modal-backdrop");
    });

    it("keeps footer buttons clickable", () => {
        const onClick = renderModal();
        const footerButton = screen.getByRole("button", { name: "Connect now" });
        expect(onClick).not.toHaveBeenCalled();
        fireEvent.click(footerButton);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("stacks the panel above the backdrop in app.css", () => {
        const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
        const backdrop = /\.modal-backdrop\s*{[^}]*}/.exec(css)?.[0] ?? "";
        const modal = /\.modal\s*{[^}]*}/.exec(css)?.[0] ?? "";
        expect(backdrop).toContain("z-index: 60");
        expect(modal).toContain("position: relative");
        expect(modal).toContain("z-index: 61");
    });
});
