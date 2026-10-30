# The session-list status dot

The Chat page's session list draws one small circle per row. Its meaning is **owned by
pi2.nvim**, not by this daemon: the browser mirrors `:PiSessions`
(`lua/pi/ui/sessions.lua` — `M.dot_hl`, `child_dot_hl`, `refresh_current_markers`,
`format_line`, `lua/pi/ui/highlights.lua`, `lua/pi/ui/tasks.lua`). Change one side and the
other must follow.

Everything below is computed in `web/src/features/chat/session-state.ts`
(`sessionDot` / `childSessionDot` / `subagentDot`) and rendered by `<StatusDot>`
(`web/src/components/ui/status-dot.tsx`). Each returns a `DotView`,
`{ status: DotStatus; blink?: "fast" | "slow"; current?: boolean }`. The wire is untouched —
the dot is a pure view of `SessionState`.

## Where the blink is decided

**Blinking is a property of the view (`DotView.blink`), never of the colour class and never
of the DOM location.** Omitting `blink` means solid.

That rule exists because breaking it was the bug: keying the animation off the colour class
plus a component scope (`html[data-pi-blink-fast="dim"] .tree-row .dot--ok`) made green blink
only inside the session tree and sit steady elsewhere, `.dot--busy`/`.dot--err` blazed
globally, `dot--steady` could not opt an `ok` dot out, and a failed task's `dot--err` blinked
forever with nothing to acknowledge it.

The renderer adds `dot--blink-fast` or `dot--blink-slow` only when `blink` is set, and
`app.css` has exactly two dim rules, with no colour or component scoping:

```css
html[data-pi-blink-fast="dim"] .dot--blink-fast,
html[data-pi-blink-slow="dim"] .dot--blink-slow { opacity: .35; }
```

CSS therefore never decides *whether* a dot blinks, only *when* the shared clock dims it. A
dot without `dot--blink-*` never animates. `dot--steady` is gone: to make a dot solid, omit
`blink`. `DOT_CLASS` is colour-only. Server and health dots (topbar chip, nav rail, status
page, workspace cards) carry no blink class at all.

## Parent rows (`sessionDot`)

Priority order, highest first:

| # | condition | class | blink | visual |
|---|---|---|---|---|
| 1 | `status === "exited"` or `"interrupted"` | `dot--dead` | — | solid red |
| 2 | `flags.error` | `dot--err` | fast | red |
| 3 | `flags.attention` or `attention.length > 0` | `dot--attention` | — | amber + ring |
| 4 | `flags.done` | `dot--ok` | fast | green |
| 5 | `status === "busy"` | `dot--busy` | fast | amber |
| 6 | `status === "compacting"` | `dot--compacting` | slow | violet |
| 7 | anything else (`idle`, `starting`) | `dot--idle` | — | grey |

`interrupted` and `exited` share the top slot because the plugin has no `interrupted`: any
non-running row is `exited`, and a dead row outranks its own unread flags.

## The "you are here" marker (`withCurrent`)

The row the console has open gets `dot--current` (blue) — the browser analogue of the
plugin's current-tab marker (`refresh_current_markers`), which repaints the focused dot in the
agent colour. It is suppressed whenever a notification colour applies (error / done /
attention); idle and busy rows keep their rate and gain the class, a focused `compacting` row
is painted `busy` + fast instead of half speed. `sessionStatusKey()` keeps the *text* label
separate: `interrupted` reads "interrupted" even though its dot is the dead red.

## Sub-session rows (`childSessionDot`)

A separate matrix (`child_dot_hl`), not the parent's:

| condition | class | blink |
|---|---|---|
| `status === "exited"` (the wire folds `dormant` into it) | `dot--exited` — hollow ring (the plugin's `◌`) | — |
| `status === "interrupted"` | `dot--dead` | — |
| `flags.error` | `dot--err` | solid **while viewed**, fast otherwise |
| `busy` or `compacting` | `dot--busy` (the plugin blinks both at the busy rate) | fast |
| anything else | `dot--idle` | — |

A child never shows `ok` or `attention`: the plugin forces `done = false` and
`attention = 0` for children and surfaces completion/failure in the parent chat.

## Manifest-only subagents (`subagentDot`)

| status | class | blink |
|---|---|---|
| `active` | `dot--busy` | — |
| `completed` / `dormant` | `dot--exited` (hollow) | — |
| `failed` | `dot--err` | solid **when viewed**, fast otherwise |
| `interrupted` | `dot--dead` | — |
| unknown | `dot--idle` | — |

A finished subagent is **hollow, not green** — the plugin shows a finished child as dormant
`◌`. An `active` manifest row is amber but **solid**: a manifest entry that still has a live
session is rendered as that session's row (which blinks while busy), so a manifest-only row is
either a spawn in flight or stale, and nvim blinks neither — nothing would acknowledge it.


## Task dots (`:PiTasks` parity)

`taskDotView` (exported by `session-tray.tsx`, reused by the task-output modal) is the one
task matrix for the chat surfaces; the `/status` task card renders the same colours solid.
Nothing ever acknowledges a task, so its terminal states are always solid — a failure must not
blink forever.

| task status | class | blink |
|---|---|---|
| `running` | `dot--busy` | fast |
| `completed` | `dot--ok` | — |
| `failed` | `dot--err` | — |
| `stopped` | `dot--attention` | — |

## The head dot agrees with its row

The stream-head dot renders the same `DotView` as the selected tree row —
`sessionDot(active, { viewed: true })` — so one session can never show two different blink
rates at once.

## `done` / `error` are unread markers, not states

The plugin raises `done` only for a session the user is **not** looking at, and
`clear_flags` wipes `done`/`error` on `TabEnter`. `useSessionsStore.markSeen(sessionId)` is
the browser's TabEnter: `pages/chat.tsx` calls it when the routed session carries either flag,
so the session you open stops being green or red — which is why a viewed child or subagent
failure is solid while an unviewed one blinks. The canonical reducer (`src/protocol/reducer.ts`)
and `fixtures/` are deliberately untouched: this is a client-side view concern.

The acknowledgement is **durable**, because the plugin keeps raising the flag until nvim's own
`TabEnter`: an in-memory-only `markSeen` meant the next snapshot (a page reload, or a reconnect's
resync) replayed `done: true` and the green blink returned for a notification the user had
already seen. `web/src/features/chat/acknowledged.ts` persists it in `localStorage`
(`pi2-seen-sessions`, per browser) under the **occurrence** it was given for — the id of the
transcript's newest entry. A replayed snapshot is the same occurrence (same trailing entry id),
so the store clears the flag on ingress; the next completed turn appends entries first, so its
token differs and that new notification blinks again. A notification for a state with no entries
cannot be scoped and is never suppressed. `removeSession` forgets the row and the `tmp-N` →
real-id migration moves it.

## One clock for every dot

No dot animates itself. `web/src/lib/blink.ts` owns a single ref-counted 500ms interval that
writes `data-pi-blink-fast` (`tick % 2`) and `data-pi-blink-slow` (`floor(tick / 2) % 2`) on
`<html>`, so every blinking dot is in lockstep instead of drifting.
`prefers-reduced-motion: reduce` pins both attributes `on` and never starts the timer.

## The contract is pinned

`web/tests/status-dot.blink-css.test.ts` loads the real stylesheets into jsdom and asserts that
a colour-only dot stays solid in both clock phases and that placement (inside versus outside
`.tree-row`) changes nothing. Add a case there before changing any blink behaviour.
