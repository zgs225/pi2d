# Releasing pi2d

Steady-state publishing is fully automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) and authenticates with
**npm Trusted Publishing (OIDC)**. The publish step gets no token: the workflow asks GitHub for a
short-lived OIDC token and the npm CLI trades it for publish rights.

```
bump version → git tag v<version> → push tag → release.yml → npm publish (OIDC) → GitHub release
```

That pipeline applies to **every release after the first one**. The very first version has to be
published by hand — see [Bootstrap](#bootstrap-the-first-publish-three-phases) — because npmjs.com
only offers the Trusted Publisher settings page for a package that already exists on the registry,
and `pi2d` does not exist yet (`npm view pi2d` → 404).

## Bootstrap: the first publish (three phases)

### Phase 0 — publish the first version from your machine (once, no provenance)

npmjs.com has no `pi2d` package page yet, so there is nowhere to configure a trusted publisher and
CI cannot authenticate. The first version is therefore published manually from the repo root:

```bash
npm login                      # account zgs225; 2FA prompt
npm whoami                     # must print: zgs225
npm publish --access public    # from the repo root; runs `prepack` (builds dist/ and web/dist/)
```

This bootstrap tarball is **built and published from your machine, so it has no provenance
attestation** — that is expected and unavoidable. Every release after it is built and published by
`release.yml` via OIDC and does carry automatic provenance.

The version you publish here is burned: `npm` rejects a second publish of the same version, so the
first CI release must use a **higher** `package.json` version (bump it in Phase 2, before tagging).

### Phase 1 — register the trusted publisher (possible only now)

The package page exists after Phase 0. Configure the publisher on
<https://www.npmjs.com/package/pi2d> — no CI secrets are involved.

1. **Log in** to npmjs.com as an owner of `pi2d` (account `zgs225`) and make sure 2FA is enabled on
   that account.
2. Package page → **Settings** → **Trusted publishing** → **Add a trusted publisher** →
   **GitHub Actions**.
3. Fill in exactly these fields (they are matched literally):

   | Field | Value |
   |---|---|
   | Organization or user | `zgs225` |
   | Repository | `pi2d` |
   | Workflow filename | `release.yml` |
   | Environment name | *leave empty* (the workflow declares no `environment:`) |
   | Allowed actions | tick **`npm publish`** (see next point) |

   * The workflow filename is **just the filename** — `release.yml`, not
     `.github/workflows/release.yml`.
   * Filenames are **case-sensitive**: `Release.yml` or `release.yaml` will not match.

4. **⚠️ Tick `npm publish` under "Allowed actions".** Trusted publishers created after
   **2026-09-03** default to allowing **`npm stage publish` only**, and this workflow runs a plain
   `npm publish`. `npm stage publish` itself is *always* allowed (it is not a switch you can turn
   off), but a plain `npm publish` is **not** covered by it — if you leave the box unticked the CI
   publish is rejected. (No need to "add" `npm stage publish`; it is on regardless.)
5. **⚠️ Publish within 2 days.** A newly created trusted publisher must complete its first
   successful publish within **2 days**, otherwise it expires and can no longer be edited — you have
   to delete it and create a new one. Create it when you are ready to tag, then go straight to
   Phase 2.
6. **No token secret.** Delete any `NPM_TOKEN` / `NODE_AUTH_TOKEN` repository secret (GitHub →
   Settings → Secrets and variables → Actions). The workflow fails when one is present.

Provenance needs no configuration: it is generated automatically for a public package published
from a public repo via OIDC. `--provenance` is not passed (and must not be re-added).

### Phase 2 — first CI release, then lock it down

```bash
# 1. bump to a version HIGHER than the Phase 0 bootstrap version
#    (edit package.json "version", then commit and push)
# 2. tag and push — this triggers the workflow
git tag v0.1.1
git push origin v0.1.1
```

Wait for the run to succeed (it must finish within the 2-day window from Phase 1). Then retire the
bootstrap credential:

1. <https://www.npmjs.com/settings/zgs225/tokens> → delete the *Automation* (or granular) token
   used in Phase 0.
2. GitHub → Settings → Secrets and variables → Actions → delete the `NPM_TOKEN` secret, if any.
3. Package settings → **Require 2FA and disallow tokens**, so no token can publish at all and OIDC
   is the only path.

From here on, only the [release checklist](#release-checklist-every-release) is needed.

## Requirements (must hold)

| Thing | Required | Where it is enforced |
|---|---|---|
| npm CLI | **>= 11.5.1** | `Upgrade npm` step (`npm install -g npm@11`) + `Preflight` step |
| Node | **>= 22.14.0** | `Preflight` step (`node 22` from `actions/setup-node` is 22.x, fine) |
| Workflow permissions | `id-token: write` + `contents: write` | top-level `permissions:` in `release.yml` |
| Registry | `https://registry.npmjs.org` | `actions/setup-node` `registry-url` |
| Auth token in the **publish** step | **none** | no `env:` on the publish step; `Refuse token-based publishing` step |
| `package.json` `repository.url` | `git+https://github.com/zgs225/pi2d.git` | nothing in CI — informational only (see below) |

Why the two permissions:

* `id-token: write` lets the job mint the OIDC token npm exchanges for publish rights.
* `contents: write` is required by the `softprops/action-gh-release` step that creates the GitHub
  release; with `contents: read` that step fails with 403. It is granted at workflow level because
  the release step lives in the single `publish` job — a separate job would mean a second
  checkout + install + test cycle for no benefit. The npm publish step still receives no token.

`repository.url` is **not validated by CI**. Nothing fails if it drifts; it only feeds npm's
"Repository" link and the provenance metadata, so keep it pointing at the GitHub repo manually.

`actions/setup-node@v4` with `node-version: 22` installs npm **10.x**, which cannot do trusted
publishing — hence the explicit `npm install -g npm@11` followed by the preflight assertion that
fails the job when `npm --version` < 11.5.1. Do not drop either step.

## Release checklist (every release)

```bash
# 1. bump version in package.json and commit/push
node -p 'require("./package.json").version'   # e.g. 0.1.1

# 2. optional but recommended: prove the tarball still builds and packs
npm publish --dry-run --access public 2>&1 | tail -5

# 3. tag and push — this is what triggers the workflow
git tag v0.1.1
git push origin v0.1.1
```

The tag must equal `package.json.version` (without the `v`); `release.yml` checks this first and
fails fast on a mismatch. The publish step runs `npm publish --access public` with no token, and
`prepack` builds `dist/` and `web/dist/` so the tarball always comes from the tagged source.
After a successful publish the workflow opens a GitHub release with generated notes.

The dry run above warns about missing auth — expected locally, it never contacts the registry for
a real publish. It still validates `prepack`, the `files` list and the tarball contents.

## Verifying a publish

```bash
npm view pi2d version dist.integrity dist.attestations
npm view pi2d dist.tarball
npm audit signatures                 # in a scratch dir, after `npm i pi2d`
```

* npmjs.com shows a green **provenance badge** on the package page and on the version's
  "Provenance" section; it links to the exact commit and workflow run that built the tarball.
  (The Phase 0 bootstrap version has no badge — that is expected.)
* `npm view pi2d dist.integrity` must match the tarball you expected; the release page should list
  the attestation (`dist.attestations.provenance`).
* In the workflow log, the publish step should report authenticated publishing via OIDC — never a
  token.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ENEEDAUTH` / "Unable to authenticate" / "not authenticated" on publish | May — not certainly — be a trusted-publisher/OIDC mismatch; if OIDC itself worked the error is a policy denial. Check, in order: (1) workflow filename is exactly `release.yml` (case-sensitive, filename only); (2) "Allowed actions" has **`npm publish`** ticked (post-2026-09-03 configs allow only `npm stage publish` by default, and stage publishing is *always* allowed, so it will not cover a plain `npm publish`); (3) `permissions: id-token: write` is present; (4) the package exists on the registry and the trusted publisher is attached to *that* package; (5) owner/repo are `zgs225`/`pi2d`. The account that pushed the tag does not matter — matching uses owner, repo and workflow filename only (a fork or a renamed repo will not match). |
| Preflight fails: `npm 10.x is too old for trusted publishing` | `npm install -g npm@11` step was removed, or the preflight ran before it. Order matters: upgrade, then assert. |
| Preflight fails: `no OIDC token endpoint` | `permissions: id-token: write` missing/overridden at job level, or the workflow is not running on GitHub Actions. |
| `Refuse token-based publishing` fails | A repository secret named `NODE_AUTH_TOKEN` or `NPM_TOKEN` exists (the guard step maps both into its own env precisely to detect this). Delete the secret — OIDC is the intended path. |
| `Create GitHub release` fails with 403 | Workflow `permissions:` lost `contents: write`. |
| Publish rejected: version already exists | The tag was reused, or you tagged the Phase 0 bootstrap version. Bump `package.json`, delete the tag locally and remotely, re-tag. |
| Trusted publisher "expired"/not editable | The 2-day first-publish window lapsed. Delete it, create it again, and publish promptly. |
| No "Trusted publishing" section on npmjs.com | The package does not exist on the registry yet → do Phase 0 first. |
| `repository.url` looks wrong on npm | Nothing in CI validates or fails on it; fix `git+https://github.com/zgs225/pi2d.git` in `package.json` and publish again. |

### Fallback: publishing with a token (not the default path)

If trusted publishing is temporarily unusable (e.g. the 2-day window expired mid-release), a
manual publish from a workstation is an acceptable emergency fallback — **a documented exception,
not the norm**:

```bash
npm login                       # account zgs225, 2FA
npm whoami                      # confirm identity
npm publish --access public     # runs prepack locally, publishes from this machine
```

Set the token on that single command only if an interactive login is impossible, e.g.
`npm publish --access public --//registry.npmjs.org/:_authToken="$TOKEN"` (it is not read from a
bare `NODE_AUTH_TOKEN` env var unless an `.npmrc` expands it). Never add the token back to GitHub:
the release workflow deliberately rejects it.
