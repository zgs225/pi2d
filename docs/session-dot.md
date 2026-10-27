# The session-list status dot

The Chat page's session list draws one small circle per row. Its meaning is **owned by
pi2.nvim**, not by this daemon: the browser mirrors `:PiSessions`
(`lua/pi/ui/sessions.lua` — `M.dot_hl`, `child_dot_hl`, `refresh_current_markers`,
`format_line`, `lua/pi/ui/highlights.lua`). Change one side and the other must follow.

Everything below is computed in `web/src/features/chat/session-state.ts`
(`sessionDot` / `childSessionDot` / `subagentDot`, all returning a `DotView`) and rendered
by `<StatusDot>` (`web/src/components/ui/status-dot.tsx`). The wire is untouched — the dot
is a pure view of `SessionState`.

## Parent rows (`sessionDot`)

Priority order, highest first:

| # | condition | class | visual |
|---|---|---|---|
| 1 | `status === "exited"` or `"interrupted"` | `dot--dead` | solid red, steady |
| 2 | `flags.error` | `dot--err` | red, fast blink |
| 3 | `flags.attention` or `attention.length > 0` | `dot--attention` | amber + ring, steady |
| 4 | `flags.done` | `dot--ok` | green, fast blink |
| 5 | `status === "busy"` | `dot--busy` | amber, fast blink |
| 6 | `status === "compacting"` | `dot--compacting` | violet, slow blink |
| 7 | anything else (`idle`, `starting`) | `dot--idle` | grey, steady |

`interrupted` and `exited` share the top slot because the plugin has no `interrupted`: any
non-running row is `exited`, and a dead row outranks its own unread flags.

## Sub-session rows (`childSessionDot`)

A separate matrix (`child_dot_hl`), not the parent's:

| condition | class |
|---|---|
| `status === "exited"` (the wire folds `dormant` into it) | `dot--exited` — hollow ring (the plugin's `◌`) |
| `status === "interrupted"` | `dot--dead` |
| `flags.error` | `dot--err`, plus `dot--steady` **while the row is viewed** |
| `busy` or `compacting` | `dot--busy` (the plugin blinks both at the busy rate) |
| anything else | `dot--idle` |

A child never shows `ok` or `attention`: the plugin forces `done = false` and
`attention = 0` for children and surfaces completion/failure in the parent chat.

## Manifest-only subagents (`subagentDot`)

`active` → busy, `completed`/`dormant` → hollow, `failed` → err (steady when viewed),
`interrupted` → dead, unknown → idle. A finished subagent is **hollow, not green** — the
plugin shows a finished child as dormant `◌`.

## The "you are here" marker

The row the console has open gets `dot--current` (blue) — the browser analogue of the
plugin's current-tab marker, which repaints the focused dot in the agent colour. It is
suppressed whenever a notification colour applies, and a focused `compacting` row blinks at
the busy rate instead of half speed. `sessionStatusKey()` keeps the *text* label separate:
`interrupted` reads "interrupted" even though its dot is the dead red.

## `done` / `error` are unread markers, not states

The plugin raises `done` only for a session the user is **not** looking at, and
`clear_flags` wipes `done`/`error` on `TabEnter`. `useSessionsStore.markSeen(sessionId)` is
the browser's TabEnter: `pages/chat.tsx` calls it when the routed session carries either
flag, so the session you open stops being green or red. The canonical reducer
(`src/protocol/reducer.ts`) and `fixtures/` are deliberately untouched — this is a
client-side view concern.

## One clock for every dot

No dot animates itself. `web/src/lib/blink.ts` owns a single ref-counted 500ms interval
that writes `data-pi-blink-fast` (`tick % 2`) and `data-pi-blink-slow`
(`floor(tick / 2) % 2`) on `<html>`; `app.css` derives the dim phase from those attributes,
so every dot in the app blinks in lockstep instead of drifting. `dot--steady` opts a dot
out, and `prefers-reduced-motion: reduce` pins them all solid (the timer is never started).
