# Releasing webtessera

A release publishes one tarball, built and tested once, to two registries:

| Registry | Package | Install with |
| --- | --- | --- |
| npm (public) | `webtessera` | `npm install webtessera` |
| GitHub Packages | `@diagnos-tech/webtessera` | see [Installing from GitHub Packages](#installing-from-github-packages) |

Both carry the same files. The npm package has a [provenance statement](https://docs.npmjs.com/generating-provenance-statements),
and both tarballs have a [GitHub build-provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds),
so anyone can check that they were built by [`release.yml`](../.github/workflows/release.yml) from a
commit on `main`.

The only manual steps are: prepare the version, publish a GitHub Release, approve the deployment.
Everything else is the workflow.

## One-time setup

Do this once, before the first release. Nothing here is code, so none of it is in the repository.

### 1. npm credentials: trusted publishing, or a token

**Preferred: [trusted publishing](https://docs.npmjs.com/trusted-publishers)** (OIDC). No secret is stored:
npm accepts a short-lived credential that GitHub issues to this one workflow. On the package's
settings page at npmjs.com, add a *Trusted Publisher*:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `diagnos-tech` |
| Repository | `webtessera` |
| Workflow filename | `release.yml` |
| Environment name | `release` |

**Bind the publisher to the `release` environment**, as in the table: both the workflow file name
and the environment name are required, not optional. GitHub puts the environment into the
credential it issues, and npm accepts it only if it says `release`. That environment is protected
(next section), so none of these can publish, whatever their code does: a dry run (it uses the
`release-dry-run` environment), a copy of `release.yml` on a branch (it cannot use `release`, because
only version tags may), or any other workflow.

npm only generates provenance for a public repository whose URL matches `repository.url` in
`package.json` (it does: `github.com/diagnos-tech/webtessera`), so the repository must be public
before the first release.

**The first release needs a token.** npm keeps the trusted-publisher setting on the package's page,
which exists only after the package has been published once (the name `webtessera` was unclaimed
when this was written). So for `0.1.0`:

1. On npmjs.com create a *granular access token* with read and write permission on all packages, an
   expiry of a few days, and the option that lets it publish without a one-time password.
2. Store it as the secret `NPM_TOKEN` of the **`release` environment** (next section) and nowhere
   else. Never add it as a repository or organisation secret: those are readable by every workflow
   on every branch, so a pull request or a branch copy of a workflow could send it elsewhere. An
   environment secret is released only to jobs that pass the environment's rules, i.e. a reviewed
   run on a `v*` tag. (As a second line of defence, `release.yml` never hands the token to a dry
   run, whatever its scope.)
3. Release `0.1.0` as described below.
4. Configure the trusted publisher above, delete the `NPM_TOKEN` secret and revoke the token.

If npm's interface lets you configure the trusted publisher before the first publish by the time
you read this, skip the token. The workflow tries the OIDC exchange first and falls back to
`NPM_TOKEN` only if it fails, so nothing in the workflow changes between the two.

Add a second maintainer to the npm package so that one lost account cannot lock the project out.

### 2. The `release` environment

*Settings, Environments, New environment, `release`.* It is what puts a human between a published
GitHub Release and the registries.

- **Required reviewers:** at least one maintainer other than whoever usually publishes releases.
  Both publish jobs wait on this environment, and approving once releases both. Tick *Prevent
  self-review* if there is more than one maintainer.
- **Deployment branches and tags:** *Selected branches and tags*, with the tag pattern `v*` and no
  branch pattern. This is the rule that keeps a modified copy of the workflow on a branch, or a
  manual run from a branch, away from the environment's secrets and from its OIDC identity (which
  is what npm's trusted publisher checks).
- **Secrets:** `NPM_TOKEN`, only while trusted publishing is not set up (see above), and only here.

The workflow also references an environment named `release-dry-run` for dry runs. Leave it without
protection rules and without secrets; GitHub creates it the first time a dry run uses it.

### 3. Branch and tag protection

- **Branch protection (or a ruleset) on `main`:** require a pull request and require the status check
  **`CI passed`**. It is the one check that stays correct when jobs are added or renamed.
  The CI workflow also runs for the merge queue, so the queue can be enabled.
- **A tag ruleset for `v*`:** restrict who can create these tags to maintainers. The release workflow
  also refuses a tag whose commit is not on `main`, but the ruleset stops the attempt earlier.

### 4. GitHub Packages

Nothing to configure before the first publish: the workflow's `GITHUB_TOKEN` (with `packages: write`)
creates the package and links it to this repository. After the first publish:

1. Open the package (*the repository's Packages, `webtessera`*, then *Package settings*) and check that
   its visibility is **Public**. If it is not, change it. Visibility can be set once the package exists.
2. Under *Manage Actions access*, check that this repository has the **Write** role, so later
   releases can publish with `GITHUB_TOKEN`.

## Making a release

1. **Check `main`.** The latest commit has a green `CI passed`, and `CHANGELOG.md` describes what is
   in it under `## [Unreleased]`.
2. **Prepare the version in a pull request.** Choose the version ([Semantic Versioning](https://semver.org/spec/v2.0.0.html);
   below 1.0.0 a minor release may break the API, and the changelog says so). Then:
   - in `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add a new, empty
     `## [Unreleased]` above it;
   - in `package.json`, set `"version": "X.Y.Z"`.

   Merge it once `CI passed` is green.
3. **Rehearse (optional, recommended for the first release and after changing the workflow).** Run the
   workflow as described in [Dry run](#dry-run).
4. **Publish a GitHub Release.** *Releases, Draft a new release*:
   - **Tag:** `vX.Y.Z`, created on `main` at the commit from step 2. The tag must equal `v` followed by
     the `package.json` version.
   - **Notes:** paste the version's section of `CHANGELOG.md`.
   - **Pre-release:** tick it if and only if the version has a suffix such as `-rc.1`. The workflow
     fails if the box and the version disagree, because the version decides the npm dist-tag
     (`latest` for stable versions, `next` for pre-releases) and the box is what people see.

   Click *Publish release*. That starts [`release.yml`](../.github/workflows/release.yml).
5. **Approve the deployment.** Open the run in the *Actions* tab. Once verification has passed it waits
   for a reviewer on the `release` environment; *Review deployments*, tick `release`, approve.
6. **Verify** as described in [Verifying a release](#verifying-a-release).

### What the workflow does

| Stage | Job | What it does and what stops it |
| --- | --- | --- |
| 1 | `prepare` | The tag is `v` + the `package.json` version; `CHANGELOG.md` has a `## [X.Y.Z]` section; the Release's pre-release flag agrees with the version; the commit is an ancestor of `main`. |
| 2 | `verify` | The whole CI ([`ci.yml`](../.github/workflows/ci.yml)): lint, types, every test suite, compatibility with Go, runtimes, examples, the site, and the packaging checks. Its `build` job packs the tarballs (`bun pm pack`) from the lockfile's dependencies, records their SHA-256 and uploads them as the `package` artifact; a separate `check` job tests them. |
| 3 | `attest` | A GitHub build-provenance attestation for both tarballs. |
| 4 | `publish-npm`, `publish-github-packages` | Download the `package` artifact (nothing is rebuilt) and publish it, behind the `release` environment. |
| 5 | `assets` | Attach the tarballs to the GitHub Release. |

Each stage runs only if the previous one passed. Each job holds only the permissions it needs; see the
comments in the workflow for which and why.

**Why the tarball cannot change on its way to the registries.** The tools that check the package
(publint, Are the Types Wrong?, and the `npm install` inside the smoke test) are fetched from the
registry rather than from the lockfile, so their code is the least controlled code in the pipeline.
They run in the separate `check` job, which holds no secrets and may only read. The job that builds
the tarballs ([`_package.yml`](../.github/workflows/_package.yml), job `build`) records their SHA-256
as job outputs the moment it has packed them, and ends. Outputs travel outside the artifact store,
so `attest`, both publish jobs and `assets` each compare the tarballs they download with those
recorded digests before doing anything else, and stop if a single byte differs or a file is
missing or extra. The guarantee is: what is attested, published and attached is what `build` packed
from the lockfile.

**Why Bun packs and npm uploads.** Bun is this project's package manager, so `bun pm pack` makes the tarball
([`_package.yml`](../.github/workflows/_package.yml)), but the upload is `npm publish`, from jobs that
have Node and npm and no Bun. `bun publish` supports neither of the two things that make a release
verifiable: npm's provenance statement (`--provenance`, [oven-sh/bun#15601](https://github.com/oven-sh/bun/issues/15601))
and trusted publishing, the OIDC exchange that needs no stored secret
([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423)). Nothing about the digests changes: `npm
publish <tarball>` uploads the file it is given, byte for byte (the shasum and integrity it prints are the
file's), so the SHA-256 recorded when `build` packed it is the digest of what the registry receives. Bun
also makes the GitHub Packages variant ([`rescope.mjs`](../scripts/release/rescope.mjs)); npm cannot, because
it runs a package's `prepare` script when it packs a directory even with `--ignore-scripts`, and that script
is not in the tarball. The two packers do not produce the same bytes (they order the entries differently), but
they select the same files with the same contents, and `build` asserts that on every pull request: it asks
`npm pack --dry-run` which files it would pack from the same tree and fails on any difference, long before a
release.

**Why two package names.** GitHub Packages' npm registry accepts only packages scoped to the owner of
the repository, so `webtessera` cannot be published there. [`scripts/release/rescope.mjs`](../scripts/release/rescope.mjs)
makes the second tarball from the first: same files, byte for byte, with `name` changed to
`@diagnos-tech/webtessera` in `package.json`, and it checks that nothing else differs. The derivation
runs on every pull request, so it cannot first fail on release day. The GitHub Packages tarball is
published without npm's own `--provenance` statement (that is for the public npm registry); the
GitHub attestation covers it instead.

## Dry run

A dry run does everything except the upload: the checks, the full CI, the tarballs, the digest
verification, and `npm publish --dry-run` against both registries, which validates the package
without publishing it. It also looks each version up on the registries. No attestation is created.
Because the digest hand-over from CI to the release jobs only runs inside this workflow, a dry run
is also the way to prove that part works before the first real release.

From the command line:

```sh
gh workflow run release.yml --ref main -f dry-run=true
```

or *Actions, Release, Run workflow*, with *Use workflow from* set to the branch or tag to rehearse
and the dry-run box ticked (it is ticked by default).

The dry run applies the same rules as a real release, so it fails exactly where the real one would:
before the version is bumped and the changelog is dated, `prepare` rejects it. It needs no approval, because
it uses the unprotected `release-dry-run` environment. A real publish (dry run unticked) is accepted
only from a version tag.

## Recovering and re-running

A release touches two registries and can stop half way. It is safe to run again: use *Re-run failed
jobs* (or *Re-run all jobs*) on the run. Publishing goes through
[`scripts/release/publish.mjs`](../scripts/release/publish.mjs), which first asks the registry what it
holds for that version:

| The registry holds | Result |
| --- | --- |
| nothing | the tarball is published |
| this exact tarball (same sha512) | the job succeeds and says so; nothing is uploaded |
| something else under this version | the job fails, naming both hashes. A published version is immutable; fix forward with a new version. |
| (the lookup itself fails, e.g. a 5xx) | the job fails; re-run it |

*Re-run failed jobs* reuses the `package` artifact of the original run, so the bytes are identical.
That artifact is kept for 14 days; after that, or with *Re-run all jobs*, the tarball is rebuilt.
It is normally reproducible, but if the registry reports different contents for it, fix forward
with a new version rather than fighting the hash.

A bad release cannot be unpublished from npm in practice (see npm's unpublish policy). Mark it with
`npm deprecate webtessera@X.Y.Z "reason, use X.Y.Z+1"`, and publish a fixed version.

## Verifying a release

The version below is `X.Y.Z`.

**npm provenance.** The package page on npmjs.com shows a *Provenance* section linking to the commit and
workflow. From a shell, in any project that has installed the package:

```sh
npm install webtessera@X.Y.Z
npm audit signatures        # checks registry signatures and provenance of every installed package
```

**GitHub attestation**, for either tarball (needs the [GitHub CLI](https://cli.github.com/)):

```sh
npm pack webtessera@X.Y.Z   # downloads webtessera-X.Y.Z.tgz exactly as npm serves it
gh attestation verify webtessera-X.Y.Z.tgz \
  --repo diagnos-tech/webtessera \
  --signer-workflow diagnos-tech/webtessera/.github/workflows/release.yml
```

The same command verifies the `.tgz` files attached to the GitHub Release.

**Same bytes everywhere.** The tarball from npm, the one on the GitHub Release and the CI artifact
share one hash:

```sh
npm view webtessera@X.Y.Z dist.integrity
echo "sha512-$(openssl dgst -sha512 -binary webtessera-X.Y.Z.tgz | openssl base64 -A)"   # the same line
```

## Installing from GitHub Packages

GitHub's npm registry serves scoped packages only, and requires an authentication token for every
install, public packages included. So most users should install from npm; GitHub Packages exists for
those who want everything inside GitHub.

In the project's `.npmrc` (or `~/.npmrc`):

```ini
@diagnos-tech:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` here is any token with the `read:packages` scope (a classic personal access token), kept
in the environment rather than in the file. Inside GitHub Actions use `${{ secrets.GITHUB_TOKEN }}` in a job
with `packages: read`. Then:

```sh
npm install @diagnos-tech/webtessera
```

and import from `@diagnos-tech/webtessera` instead of `webtessera`. To keep the import path `webtessera`,
install under an alias:

```sh
npm install webtessera@npm:@diagnos-tech/webtessera
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `prepare` fails with "tag ... does not match package.json version" | The Release was created for a tag other than `v` + the version. Delete the Release and the tag, fix the version or the tag, and publish again. |
| `prepare` fails with "no `## [X.Y.Z]` section" | `CHANGELOG.md` still says `## [Unreleased]` for this version. |
| `prepare` fails with "not an ancestor of main" | The tag points at a commit that is not on `main`. Tag a commit from `main`. |
| `publish-npm` fails with `ENEEDAUTH`, or a 404 on `PUT` | Neither trusted publishing nor `NPM_TOKEN` worked. Check the trusted-publisher fields (especially the workflow file name `release.yml` and the environment name `release`) or the `NPM_TOKEN` secret of the `release` environment. A token needs publish rights without a one-time password. |
| `publish-npm` fails with "npm ... is older than 11.5.1" | The Node.js version set by `PUBLISH_NODE_VERSION` in `release.yml` ships an older npm. Move to a newer Node.js release. |
| `publish-github-packages` fails with `permission_denied` | The package exists but this repository lacks the **Write** role under *Manage Actions access*, or the package belongs to another repository. |
| A job fails at "Verify the tarballs against the recorded digests" | The artifact is not what `build` packed (or a digest did not arrive). Treat it as a possible tampering until explained: look at the run's `package` job summary for the recorded digests, then re-run the whole workflow (*Re-run all jobs*), which rebuilds and records new ones. |
| `Check that npm would pack the same files` fails with a diff | `bun pm pack` and `npm pack` no longer select the same files: a new `files` pattern, or a Bun release, changed how one of them reads it. The diff names the files; `files` in `package.json` is written for npm's rules, so fix the pattern, or the Bun version, until they agree. |
| `Derive the GitHub Packages variant` fails with "file lists differ" or "differs between the two tarballs" | The unpacked tarball was changed by more than its package name, or Bun packed it differently the second time. Run `node scripts/release/rescope.mjs <tarball> --scope <owner>` locally to see which file. |
| A job fails with "already exists ... with different contents" | The registry holds a different build of this version. See [Recovering and re-running](#recovering-and-re-running). |
| The deployment never starts | It waits for a reviewer on the `release` environment (see step 5), or the tag does not match the environment's allowed tag pattern. |
