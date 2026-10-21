/**
 * Re-export shim for the canonical wire protocol types.
 *
 * The single source of truth is `../src/protocol/types.ts` in the daemon
 * package (aliased as `@protocol`). This module used to hold a hand-copied
 * duplicate; it now only forwards so existing imports keep working while the
 * browser and the daemon cannot drift apart.
 */
export * from "@protocol/types";
