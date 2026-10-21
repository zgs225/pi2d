import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardSub, CardTitle } from "@/components/ui/card";
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
