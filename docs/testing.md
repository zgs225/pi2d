# Testing & Performance Guide

This document describes the testing architecture for `pi2d` (both daemon and web console),
along with performance tuning strategies for local development and CI.

---

## 1. Test Architecture

The repository maintains two independent test suites across two lockfiles:

| Scope | Path | Runner | Environment | Isolation | Focus |
|---|---|---|---|---|---|
| **Daemon** | `test/` | Vitest (root) | `node` | per-file forks | CLI, routing, auth, instances, IPC, protocol conformance |
| **Web Console** | `web/tests/` | Vitest (web) | `jsdom` | shared worker (`isolate: false`) | React 19 UI, pages, TanStack router/query, token contracts |

---

## 2. Web Test Performance & CPU Optimization

Web unit tests use React 19, `@testing-library/react` and `jsdom`.

### 2.1 The DOM Isolation Overhead (`isolate: false`)
* **Problem**: By default, Vitest destroys and rebuilds a clean DOM environment for every single test file. In a suite with 35+ test files, recreating `jsdom` accounted for **52% of total CPU tracking time** (~240s CPU time per run).
* **Optimization**: Set `isolate: false` in `web/vite.config.ts`.
  - Environment instances are reused across files within each worker.
  - Test files maintain clean state using standard teardown hooks in `tests/setup.ts` (`cleanup()`, `localStorage.clear()`, theme reset).
  - **Result**: Wall clock time drops by ~37%, and total CPU time is reduced by ~40% with 100% test pass rate.

### 2.2 Worker Concurrency on Hybrid Core Architectures
* On modern CPUs with Performance and Efficient cores (e.g., Intel 12th+ Gen like i7-12700H with 6P + 8E cores):
  - Vitest defaults to spawning workers matching total logical threads (e.g. 20 workers).
  - This saturates E-cores, leading to high thermal throttling, CPU lockup, and system unresponsiveness.
  - **Recommendation for heavy multi-tasking / laptops**:
    ```bash
    pnpm --dir web exec vitest run --maxWorkers=6
    ```
    Confining workers to P-core count keeps tests fast while leaving headroom for Neovim and the desktop compositor.

### 2.3 JSDOM Stubs vs. Virtual Console Noise
* `jsdom` includes incomplete stubs (e.g., `window.scrollTo` and `HTMLCanvasElement.getContext`) that write noisy "Not implemented" warnings to stderr on every call.
* These stubs are explicitly overridden in `web/tests/setup.ts`:
  ```typescript
  if (typeof window !== "undefined") {
      window.scrollTo = vi.fn();
  }
  if (typeof HTMLCanvasElement !== "undefined") {
      HTMLCanvasElement.prototype.getContext = vi.fn();
  }
  ```
  This eliminates thousands of lines of terminal I/O overhead and keeps test logs readable.

### 2.4 Why JSDOM over Happy-DOM
* While `happy-dom` is slightly faster, real-world evaluation in `pi2-web` revealed subtle incompatibilities with TanStack Router navigation microtasks and React 19 asynchronous `act(...)` scheduling (causing failures in `ConnectPage` and `StatusPage`).
* We retain `jsdom` with `isolate: false` to preserve 100% browser behavior fidelity while achieving near-identical speed.

### 2.5 Timeout Defensive Line
* Set `testTimeout: 15000` in `web/vite.config.ts` to prevent transient timeouts when the host CPU is under heavy background load.

---

## 3. Daily Development Workflow

### 3.1 Incremental Test Runs (Recommended)
Avoid running all 35+ tests on every keystroke. Run only what changed:

```bash
# Run only test files related to uncommitted git changes
pnpm --dir web exec vitest run --changed

# Run a specific test file
pnpm --dir web exec vitest run tests/chat.composer.test.tsx
```

### 3.2 Watch Mode
Vitest's HMR-powered watch mode tracks module dependency graphs and re-runs only the affected test tree:

```bash
pnpm --dir web test
```

### 3.3 Pre-commit Full Gate
Before submitting or tagging releases, run the comprehensive verification chain:

```bash
pnpm typecheck && pnpm test && pnpm --dir web typecheck && pnpm --dir web exec vitest run
```
