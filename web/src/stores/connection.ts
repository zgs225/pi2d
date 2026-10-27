import { create } from "zustand";

import type { ServerStatusValue } from "@/features/status/server";
import type { InfoResponse } from "@/lib/api";
import { getDeviceToken, setDeviceToken } from "@/lib/api";
import type { WsConnectionState } from "@/lib/ws";

export const CONNECTION_KEY = "pi2-connection";
export const ENDPOINT_KEY = "pi2-endpoint";
export const DEVICE_KEY = "pi2-device";
export const CONNECTED_AT_KEY = "pi2-connected-at";

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

export type PairingState = "paired" | "unpaired";

export interface ConnectionStore {
    /** Mirror of the prototype's `pi2-connection` marker. */
    paired: boolean;
    endpoint: string;
    deviceName: string;
    connectedAt: number;
    token: string | null;
    server: InfoResponse | null;
    serverStatus: ServerStatusValue;
    wsState: WsConnectionState;

    isPaired: () => boolean;
    refreshFromStorage: () => void;
    connect: (options?: { endpoint?: string; deviceName?: string; token?: string | null }) => void;
    disconnect: () => void;
    setServer: (server: InfoResponse | null) => void;
    setServerStatus: (status: ServerStatusValue) => void;
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
        server: null as InfoResponse | null,
        serverStatus: "unknown" as ServerStatusValue,
        wsState: "idle" as WsConnectionState,
    };
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
    ...initialState(),

    isPaired: () => get().paired,

    refreshFromStorage: () => set(initialState()),

    connect: ({ endpoint, deviceName, token } = {}) => {
        const now = Date.now();
        if (endpoint) write(ENDPOINT_KEY, endpoint);
        if (deviceName) write(DEVICE_KEY, deviceName);
        if (token !== undefined) setDeviceToken(token);
        write(CONNECTED_AT_KEY, String(now));
        write(CONNECTION_KEY, "paired");
        set({
            paired: true,
            endpoint: endpoint ?? get().endpoint,
            deviceName: deviceName ?? get().deviceName,
            connectedAt: now,
            token: getDeviceToken(),
        });
    },

    disconnect: () => {
        drop(ENDPOINT_KEY);
        drop(DEVICE_KEY);
        drop(CONNECTED_AT_KEY);
        setDeviceToken(null);
        write(CONNECTION_KEY, "unpaired");
        set({
            paired: false,
            endpoint: "",
            deviceName: "",
            connectedAt: 0,
            token: null,
            server: null,
            serverStatus: "unknown",
            wsState: "idle",
        });
    },

    setServer: (server) => set({ server }),
    setServerStatus: (serverStatus) => set({ serverStatus }),
    setWsState: (wsState) => set({ wsState }),
    setToken: (token) => {
        setDeviceToken(token);
        set({ token: getDeviceToken() });
    },
}));
