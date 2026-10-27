# ADR 0001 — Phone-first binding and zero-input pairing

- Status: accepted (implementing)
- Date: 2026-10-26
- Supersedes: `PI2_ACCESS_MODE` (`local` / `lan` / `tailscale`)

## Context

The console has to be usable from a phone: open the link, done. Two things blocked
that:

1. **Reachability was an opt-in mode.** `PI2_ACCESS_MODE` picked the bind address
   (`local` → loopback), and CORS only allowed the single detected LAN address in
   `lan` mode. A phone that typed `http://192.168.2.10:7676` was refused by the
   origin check, and the default pairing URL was `http://127.0.0.1:7676/pair/…`,
   which is unscannable from another device.
2. **Pairing was a form, not a link.** The QR on the status page was a *fake*
   pattern (`web/src/features/status/qr.ts` derived it from a seed), so scanning
   it did nothing. The redemption endpoint and the mint endpoint shared one path
   (`POST /api/v1/pair`), distinguished by whether `body.code` was present — the
   authorization rule was implied by a field, not by the route.

Access control is already carried by the device token that a pairing code mints.
The bind address is not a security boundary we want to maintain.

## Decision

### 1. Bind every interface by default

- `PI2_HOST` defaults to `0.0.0.0`; setting it (e.g. `127.0.0.1`) narrows the bind.
- CORS derives from the addresses the daemon is actually reachable on: loopback plus
  every non-internal IPv4 at the bound port, plus `PI2_PUBLIC_URL`'s origin, plus
  `PI2_ORIGINS`. `PI2_ACCESS_MODE` and its three modes are deleted outright (the
  repo is pre-1.0 and the plugin that set the env var ships from the same project).
- `/api/v1/info` and `daemon.json` report `host` instead of `access`.

### 2. One network source of truth

`src/core/network.ts` owns address classification and ordering:

| kind | rule |
|---|---|
| `public` | the configured `PI2_PUBLIC_URL` (never a NIC) |
| `lan` | private IPv4 (10/8, 172.16/12, 192.168/16) |
| `other` | any other routed IPv4 |
| `tailscale` | `tailscale*` interface or 100.64/10 address |
| `loopback` | 127/8 |

Ordering: `public` → `lan` → `other` → `tailscale` → `loopback`, physical interface
names before virtual ones (`docker*`, `veth*`, `br-*`, `virbr*`, `tun*`, `wg*`, …),
link-local (169.254/16) never advertised. `networkBases()` respects `bindHost`:
a loopback bind advertises only loopback, a specific address advertises that
address plus loopback, `0.0.0.0`/`::` advertises everything reachable.

Config (CORS), the pairing route (URL + `bases[]`) and `pi2 doctor` all consume it.

### 3. Pairing is mint → link → redeem

```
POST /api/v1/pair          (authenticated) → {code,url,expiresAt,nonce,qr,bases[]}
POST /api/v1/pair/redeem   (public, rate limited) → {token,device}
GET  /pair/:code           (public)          → 302 /connect?code=…&auto=1
```

- The mint picks the URL server-side (`base` may be supplied, but only a value
  present in `bases[]` is accepted) and returns the QR matrix, so no client
  re-derives either.
- `qr` is byte-mode, EC level M, versions 1–10, `rows` without a quiet zone;
  renderers own margin and colours. One encoder in `src/core/qr.ts`.
- Redeem is unauthenticated by design (the code *is* the capability) and now
  rate limited: 5 attempts/minute/IP and 50/hour globally, over the limit → 429.
- Codes stay 8 characters from a 32-symbol alphabet, single use, 10 minutes.

### 4. Devices carry no scope list

Scopes were declared (`read`/`steer`/`control`/`admin`, plus a bogus `apply` in the
web client) but never enforced anywhere — HTTP and WS only checked that the token
was valid. Rather than invent an enforcement matrix, this ADR drops the concept:
a paired device and the local browser hold the same rights as `local-cli`, and any
fine-grained permission model is a separate feature with its own ADR.

Removed with it: `Scope`, `SCOPES`, `DEFAULT_SCOPES`, `DeviceRecord.scopes`,
`CreateDeviceInput.scopes`, `web`'s `PAIR_SCOPES`/`DEFAULT_DEVICE_SCOPES`, and the
`scopes` field in `/api/v1/devices` responses and the stored pair metadata.

### 5. Zero-input web flow

`/pair/<CODE>` (both the daemon's 302 and the SPA `/#/pair/CODE` route) lands on
`/connect?code=<CODE>&auto=1`, which redeems against its own origin with the
localized default device name and redirects to `next`/`/workspaces`. The code and
`auto` flag are stripped from the URL afterwards. A rejected or expired code falls
back to the manual form with host, port and code prefilled.

The in-console camera scanner (`web/src/features/connect/scan-dialog.tsx`) is
deleted: phones scan with the system camera, desktops type the code.

## Consequences

- A daemon started without configuration is reachable from the LAN. `pi2 doctor`
  reports the bind, and warns (not fails) when a non-loopback bind has no `https:`
  public URL.
- `pi2 pairing` prints a human-readable report and a terminal QR; it no longer
  emits `--json`. The Neovim client calls `POST /api/v1/pair` directly.
- Breaking for anyone parsing `info.access`, `pi2 status --json`'s `access`,
  `pi2 pairing --json`, or `POST /api/v1/pair {code}`; all in-repo callers are
  updated in the same change.
- `docs/protocol.md` no longer claims `E_FORBIDDEN` covers scopes; it covers
  origins and `PI2_WORKSPACE_ROOTS` only.
