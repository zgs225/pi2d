import { Toaster as SonnerToaster, toast } from "sonner";

export { toast };

/** App-wide toast host (sonner), styled with the design tokens in app.css. */
export function Toaster() {
    return (
        <SonnerToaster
            position="bottom-right"
            theme="system"
            richColors={false}
            closeButton={false}
            duration={2600}
        />
    );
}
