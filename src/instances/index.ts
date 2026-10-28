/**
 * Public surface of the instance layer.
 *
 * `createInstanceManager(deps)` returns an `InstanceManager` plus the plugin
 * socket server handle used by diagnostics/test harnesses.
 */

export { PluginServer, parseHello, DEFAULT_MAX_FRAME_BYTES, DEFAULT_HEARTBEAT_MS } from "./plugin-server.js";
export type { PluginServerOptions, PluginServerRejection } from "./plugin-server.js";
export {
    PluginSocketConnection,
    DEFAULT_COMMAND_TIMEOUT_MS,
    DEFAULT_MAX_WRITE_QUEUE_BYTES,
} from "./connection.js";
export type { PluginHello, SnapshotCacheEntry, PluginSocketConnectionOptions } from "./connection.js";
export {
    createInstanceManager,
    ManagedInstanceManager,
    parseEnsureTimeoutMs,
    parseProcRss,
    parsePsRss,
    summarizeResources,
    DEFAULT_ENSURE_TIMEOUT_MS,
    DEFAULT_LOG_TAIL_LINES,
    DEFAULT_MAX_INSTANCES,
    DEFAULT_RSS_FRACTION,
    DEFAULT_SHUTDOWN_GRACE_MS,
    DEFAULT_SIGTERM_GRACE_MS,
    DEFAULT_MIN_SPAWN_INTERVAL_MS,
} from "./supervisor.js";
export type { InstanceManagerDeps, InstanceManagerHandle, SpawnFunction } from "./supervisor.js";
export { HOST_INIT_FILENAME, luaString, renderHostInit, writeHostInit } from "./host-init.js";
export { InstanceError, TIMEOUT_CODE, asInstanceError, errorMessage } from "./errors.js";
