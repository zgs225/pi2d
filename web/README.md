# pi2-web

React port of the pi2 web UI prototype, built into `web/dist` and served statically by `pi2 daemon`.

## Development

```bash
# Start dev server with proxy to daemon (:7676)
pnpm --dir web dev

# Typecheck
pnpm --dir web typecheck

# Run test suite
pnpm --dir web exec vitest run

# Run only changed tests or specific file
pnpm --dir web exec vitest run --changed
pnpm --dir web exec vitest run tests/chat.composer.test.tsx

# Watch mode
pnpm --dir web test
```

For performance tuning, concurrency settings, and DOM environment details, see [docs/testing.md](../docs/testing.md).
