/** In-process event bus with failure isolation for subscriber handlers. */
import type { Bus, Logger } from "../core/interfaces.js";

export interface InMemoryBusOptions {
    logger?: Logger;
    slowHandlerMs?: number;
}

type Handler = (record: Record<string, unknown>) => void;

export class InMemoryBus implements Bus {
    private readonly handlers = new Set<Handler>();
    private readonly logger: Logger | undefined;
    private readonly slowHandlerMs: number;

    constructor(options: InMemoryBusOptions = {}) {
        this.logger = options.logger;
        this.slowHandlerMs = options.slowHandlerMs ?? 50;
    }

    publish(record: Record<string, unknown>): void {
        for (const handler of this.handlers) {
            const started = performance.now();
            try {
                handler(record);
            } catch (error) {
                this.logger?.warn("bus handler threw", {
                    type: record.type,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            const elapsed = performance.now() - started;
            if (elapsed > this.slowHandlerMs) {
                this.logger?.warn("slow bus handler", {
                    type: record.type,
                    elapsedMs: Math.round(elapsed),
                    budgetMs: this.slowHandlerMs,
                });
            }
        }
    }

    subscribe(handler: Handler): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    get subscriberCount(): number {
        return this.handlers.size;
    }
}
