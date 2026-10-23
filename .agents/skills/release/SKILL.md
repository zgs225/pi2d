---
name: release
description: Cut and verify a pi2d release — pick the version, tag it, let GitHub Actions publish to npm through Trusted Publishing (OIDC), then verify the registry artifact, provenance, a clean install and a booting daemon. Use when asked to "release", "publish", "cut a version", "bump the version", or to diagnose a failed release run.
---

# Release pi2d

Runbook. Architecture and house rules live in `AGENTS.md`; the npmjs.com checklist, provenance
rationale and the long troubleshooting table live in `../../../docs/releasing.md`. This file is the
procedure to execute.

## Non-negotiables

- **Publish only from CI.** Tag → `.github/workflows/release.yml` → OIDC. A local `npm publish`
  is the one-time bootstrap only (see below), never the steady state.
- **No tokens.** The publish step holds no credentials; the workflow's first guard step fails the
  job when `NPM_TOKEN` / `NODE_AUTH_TOKEN` is still present in the repo.
- **Tag == `package.json` version.** The workflow verifies the pair and refuses to publish a
  mismatch.
- **Push the tag explicitly.** `git push --follow-tags` only pushes *annotated* tags; a
  lightweight tag is skipped silently and `release.yml` never runs.

## Steady-state release

1. **Preconditions** — clean tree on `main`, in sync with `origin/main`, and CI green on the commit
   you are about to tag: `gh run list --repo zgs225/pi2d --workflow ci.yml --limit 3`.
2. **Pick the version with the user** (do not assume). Semver: breaking → major, feature → minor,
   fix → patch. There is no `CHANGELOG.md`; build the notes from
   `git log --oneline "$(git describe --tags --abbrev=0)"..HEAD`, grouped by conventional type.
3. **Bump and commit:**
   ```bash
   npm version <x.y.z> --no-git-tag-version
   git commit -am "chore: release <x.y.z>"
   ```
4. **Tag and push** (annotated tag, pushed explicitly):
   ```bash
   git tag -a "v<x.y.z>" -m "v<x.y.z>"
   git push origin main
   git push origin "v<x.y.z>"
   ```
5. **Watch the publish:**
   ```bash
   gh run watch "$(gh run list --repo zgs225/pi2d --workflow release.yml --limit 1 \
       --json databaseId --jq '.[0].databaseId')" --repo zgs225/pi2d --exit-status
   ```
   The interesting steps are `Upgrade npm`, `Preflight — npm/node support trusted publishing`,
   `Publish to npm (trusted publishing, no token)` and `Create GitHub release`.
6. **Verify the artifact** — do not trust a green job, check the registry:
   ```bash
   bash .agents/skills/release/scripts/verify-release.sh <x.y.z>
   ```
   It asserts the exact version is on the registry, the SLSA provenance attestation exists, a clean
   install from the public registry reports `pi2 <x.y.z>`, the tarball ships `web/dist`,
   `dist/cli/pi2.js` and `LICENSE`, the daemon boots and serves `/` + a healthy
   `/api/v1/health`, and the GitHub release exists. Every line is `PASS`/`FAIL`; exit non-zero on
   any failure.
7. **Report** the version, the run URL, the verification output and the release URL. Mention whether
   the new version is `latest` (a backport is not).

## Bootstrap (once per package name, already done for `@yuez/pi2d`)

Only relevant if the package has left the registry. npmjs.com offers the Trusted Publisher page
only for a package that already exists, so the first publish is manual:

1. From the repo root: `npm login` (account `yuez`, 2FA) → `npm whoami` → `npm publish --access public`.
   That artifact has no provenance; every later release does.
2. Then add the trusted publisher on npmjs.com: owner `zgs225` (GitHub), repo `pi2d`, workflow
   filename `release.yml`, environment empty, **and tick `npm publish`** (post-2026-09-03 configs
   allow only `npm stage publish` by default). The first CI publish must happen within 2 days or the
   configuration expires.
3. Bump to a **higher** version for the first CI release — npm rejects republishing a version.

## Failure playbook

| Symptom | Cause / action |
|---|---|
| No `release.yml` run after pushing | The tag never reached the remote. Check `gh api repos/zgs225/pi2d/tags --jq '.[].name'`; a lightweight tag plus `--follow-tags` is silent. Push the tag explicitly. |
| `ENEEDAUTH` / "Unable to authenticate" | OIDC or policy mismatch: workflow filename must be exactly `release.yml`, `npm publish` must be ticked under allowed actions, `id-token: write` must be present, and the trusted publisher must be attached to *this* package. |
| `Preflight` fails on npm version | setup-node's node 22 ships npm 10; the `Upgrade npm` step must run before the preflight. |
| `Refuse token-based publishing` fails | A `NPM_TOKEN`/`NODE_AUTH_TOKEN` repo secret still exists. Delete it — OIDC is the intended path. |
| `E403 Package name too similar` | Unscoped names hit the registry's similarity filter; this package is scoped as `@yuez/pi2d` and must stay scoped. |
| `E403 You cannot publish over the previously published versions` | The version was already published (often the bootstrap). Bump and re-tag. |
| `Create GitHub release` 403 | Workflow `permissions` lost `contents: write`. |
| `EOTP` on a local publish | Only the bootstrap needs 2FA; pass `--otp=<code>`. Steady state never publishes locally. |

## Definition of done

Registry shows the version with a `slsa.dev/provenance` attestation, `verify-release.sh` prints
`OK`, the GitHub release exists, the working tree is clean, and the report tells the user what to
install (`npm i -g @yuez/pi2d@<x.y.z>`).
