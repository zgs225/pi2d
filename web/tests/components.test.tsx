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
        ["dead", "dot--dead"],
    ] as const)("maps %s to %s", (status, expected) => {
        const { container } = render(<StatusDot status={status} />);
        expect(container.firstElementChild).toHaveClass("dot", expected);
    });

    it("applies the fast blink class only when blink='fast'", () => {
        const { container } = render(<StatusDot status="err" blink="fast" />);
        expect(container.firstElementChild).toHaveClass("dot", "dot--err", "dot--blink-fast");
        expect(container.firstElementChild).not.toHaveClass("dot--blink-slow");
    });

    it("applies the slow blink class only when blink='slow'", () => {
        const { container } = render(<StatusDot status="compacting" blink="slow" />);
        expect(container.firstElementChild).toHaveClass("dot", "dot--compacting", "dot--blink-slow");
        expect(container.firstElementChild).not.toHaveClass("dot--blink-fast");
    });

    it("carries neither blink class when blink is omitted or null", () => {
        const { container: c1 } = render(<StatusDot status="err" />);
        expect(c1.firstElementChild).not.toHaveClass("dot--blink-fast");
        expect(c1.firstElementChild).not.toHaveClass("dot--blink-slow");

        const { container: c2 } = render(<StatusDot status="err" blink={null} />);
        expect(c2.firstElementChild).not.toHaveClass("dot--blink-fast");
        expect(c2.firstElementChild).not.toHaveClass("dot--blink-slow");
    });

    it("never encodes the blink in the colour class (a solid err dot is still dot--err)", () => {
        // The old bug: the animation was keyed on the colour class + the wrapper.
        const solid = render(<StatusDot status="err" />);
        const blinking = render(<StatusDot status="err" blink="fast" />);
        expect(solid.container.firstElementChild).toHaveClass("dot--err");
        expect(blinking.container.firstElementChild).toHaveClass("dot--err");
        expect(solid.container.firstElementChild).not.toHaveClass("dot--blink-fast");
    });

    it("applies dot--current modifier when current is true", () => {
        const { container } = render(<StatusDot status="busy" current={true} />);
        expect(container.firstElementChild).toHaveClass("dot", "dot--busy", "dot--current");
    });

    it("does not apply dot--current when current is false or omitted", () => {
        const { container: c1 } = render(<StatusDot status="busy" current={false} />);
        expect(c1.firstElementChild).not.toHaveClass("dot--current");

        const { container: c2 } = render(<StatusDot status="busy" />);
        expect(c2.firstElementChild).not.toHaveClass("dot--current");
    });

    it("composes blink, current and a custom className", () => {
        const { container } = render(<StatusDot status="busy" blink="fast" current className="custom-dot" />);
        expect(container.firstElementChild).toHaveClass(
            "dot",
            "dot--busy",
            "dot--blink-fast",
            "dot--current",
            "custom-dot",
        );
    });

    it("composes a slow blink with the current marker", () => {
        const { container } = render(<StatusDot status="compacting" blink="slow" current />);
        expect(container.firstElementChild).toHaveClass(
            "dot",
            "dot--compacting",
            "dot--blink-slow",
            "dot--current",
        );
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
