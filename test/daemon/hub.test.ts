import { describe, expect, it } from "vitest";
import type { Logger, LogLevel } from "../../src/core/interfaces.js";
import { InMemoryBus } from "../../src/daemon/hub.js";

class RecordingLogger implements Logger {
    records: { level: LogLevel; msg: string; fields?: Record<string, unknown> }[] = [];

    debug(msg: string, fields?: Record<string, unknown>): void {
        this.records.push({ level: "debug", msg, fields });
    }
    info(msg: string, fields?: Record<string, unknown>): void {
        this.records.push({ level: "info", msg, fields });
    }
    warn(msg: string, fields?: Record<string, unknown>): void {
        this.records.push({ level: "warn", msg, fields });
    }
    error(msg: string, fields?: Record<string, unknown>): void {
        this.records.push({ level: "error", msg, fields });
    }
    child(): Logger {
        return this;
    }
}

describe("InMemoryBus", () => {
    it("publishes to every subscriber until unsubscribed", () => {
        const bus = new InMemoryBus();
        const first: Record<string, unknown>[] = [];
        const second: Record<string, unknown>[] = [];
        const unsubscribe = bus.subscribe((record) => first.push(record));
        bus.subscribe((record) => second.push(record));

        bus.publish({ type: "event", sessionId: "s1" });
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);

        unsubscribe();
        bus.publish({ type: "event", sessionId: "s2" });
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(2);
    });

    it("isolates handler failures and warns", () => {
        const logger = new RecordingLogger();
        const bus = new InMemoryBus({ logger });
        const seen: Record<string, unknown>[] = [];
        bus.subscribe(() => {
            throw new Error("handler exploded");
        });
        bus.subscribe((record) => seen.push(record));

        expect(() => bus.publish({ type: "event" })).not.toThrow();
        expect(seen).toHaveLength(1);
        expect(logger.records.some((record) => record.level === "warn" && /handler/i.test(record.msg))).toBe(true);
    });

    it("warns about slow handlers", () => {
        const logger = new RecordingLogger();
        const bus = new InMemoryBus({ logger, slowHandlerMs: 5 });
        bus.subscribe(() => {
            const end = Date.now() + 20;
            while (Date.now() < end) {
                // busy wait to simulate a blocking handler
            }
        });

        bus.publish({ type: "event" });
        expect(logger.records.some((record) => record.level === "warn" && /slow/i.test(record.msg))).toBe(true);
    });
});
