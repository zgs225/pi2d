import { create } from "zustand";

import type { InfoResponse } from "@/lib/api";
import { getDeviceToken, setDeviceToken } from "@/lib/api";
import type { WsConnectionState } from "@/lib/ws";

export const CONNECTION_KEY = "pi2-connection";
export const ENDPOINT_KEY = "pi2-endpoint";
export const DEVICE_KEY = "pi2-device";
export const CONNECTED_AT_KEY = "pi2-connected-at";
export const SCOPES_KEY = "pi2-device-scopes";
/** Scope assumed for devices paired before scopes were persisted. */
export const DEFAULT_CONNECTION_SCOPES = ["read"] as const;

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* private mode */
    }
}

function drop(key: string): void {
    try {
        localStorage.removeItem(key);
    } catch {
        /* private mode */
    }
}

/** Persisted device scopes; defaults to `["read"]` when absent or unreadable. */
function readScopes(): string[] {
    const raw = read(SCOPES_KEY);
    if (!raw) return [...DEFAULT_CONNECTION_SCOPES];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const scopes = parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
            return scopes.length ? scopes : [...DEFAULT_CONNECTION_SCOPES];
        }
    } catch {
        /* fall through to the default */
    }
    return [...DEFAULT_CONNECTION_SCOPES];
}

function writeScopes(scopes: string[]): void {
    write(SCOPES_KEY, JSON.stringify(scopes.length ? scopes : DEFAULT_CONNECTION_SCOPES));
}

export type PairingState = "paired" | "unpaired";

export interface ConnectionStore {
    /** Mirror of the prototype's `pi2-connection` marker. */
    paired: boolean;
    endpoint: string;
    deviceName: string;
    connectedAt: number;
    token: string | null;
    /** Device scopes granted by the daemon when this browser was paired. */
    scopes: string[];
    server: InfoResponse | null;
    wsState: WsConnectionState;

    isPaired: () => boolean;
    refreshFromStorage: () => void;
    connect: (options?: { endpoint?: string; deviceName?: string; token?: string | null; scopes?: string[] }) => void;
    disconnect: () => void;
    setServer: (server: InfoResponse | null) => void;
    setWsState: (state: WsConnectionState) => void;
    setToken: (token: string | null) => void;
}

function initialState() {
    return {
        paired: read(CONNECTION_KEY) === "paired",
        endpoint: read(ENDPOINT_KEY) ?? "",
        deviceName: read(DEVICE_KEY) ?? "",
        connectedAt: Number(read(CONNECTED_AT_KEY)) || 0,
        token: getDeviceToken(),
        scopes: readScopes(),
        server: null as InfoResponse | null,
        wsState: "idle" as WsConnectionState,
    };
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
    ...initialState(),

    isPaired: () => get().paired,

    refreshFromStorage: () => set(initialState()),

    connect: ({ endpoint, deviceName, token, scopes } = {}) => {
        const now = Date.now();
        if (endpoint) write(ENDPOINT_KEY, endpoint);
        if (deviceName) write(DEVICE_KEY, deviceName);
        if (token !== undefined) setDeviceToken(token);
        if (scopes !== undefined) writeScopes(scopes);
        write(CONNECTED_AT_KEY, String(now));
        write(CONNECTION_KEY, "paired");
        set({
            paired: true,
            endpoint: endpoint ?? get().endpoint,
            deviceName: deviceName ?? get().deviceName,
            connectedAt: now,
            token: getDeviceToken(),
            scopes: scopes !== undefined ? readScopes() : get().scopes,
        });
    },

    disconnect: () => {
        drop(ENDPOINT_KEY);
        drop(DEVICE_KEY);
        drop(CONNECTED_AT_KEY);
        drop(SCOPES_KEY);
        setDeviceToken(null);
        write(CONNECTION_KEY, "unpaired");
        set({
            paired: false,
            endpoint: "",
            deviceName: "",
            connectedAt: 0,
            token: null,
            scopes: [...DEFAULT_CONNECTION_SCOPES],
            server: null,
            wsState: "idle",
        });
    },

    setServer: (server) => set({ server }),
    setWsState: (wsState) => set({ wsState }),
    setToken: (token) => {
        setDeviceToken(token);
        set({ token: getDeviceToken() });
    },
}));
