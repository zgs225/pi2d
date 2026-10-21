import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * The design has no workspace detail page. Keep the route for deep links and
 * redirect into the chat UI, which owns the workspace-scoped session tree.
 */
export function WorkspacePage() {
    const navigate = useNavigate();
    const params = useParams({ strict: false }) as { workspaceId?: string };
    const workspaceId = params.workspaceId ? decodeURIComponent(params.workspaceId) : "";

    useEffect(() => {
        const target = workspaceId
            ? `/chat?workspace=${encodeURIComponent(workspaceId)}`
            : "/chat";
        navigate({ href: target, replace: true });
    }, [navigate, workspaceId]);

    return null;
}
