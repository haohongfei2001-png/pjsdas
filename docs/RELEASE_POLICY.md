# PJSDAS Release and Version Policy

PJSDAS distinguishes product releases, engineering milestones, runtime compatibility versions, deployed build identity, and GitHub platform release immutability. These identifiers and controls serve different purposes and must not be mechanically forced to match.

## Public product version

The first formal public product release is `v1.0.0`.

From this release onward:

- the public product version follows Semantic Versioning;
- `package.json` must carry the same numeric version as the public product release when a release plan is armed;
- the Git tag is `v<package version>`;
- the GitHub Release title uses the same public product version;
- a public release is created only from a commit that has completed the production release chain.

`v1.9`, `v1.10`, and similar labels already present in historical design and hardening documents are engineering milestones. They describe implementation rounds and product-development workstreams; they are not retroactively reinterpreted as public SemVer releases.

## Release candidate channel

A release candidate uses normal Semantic Versioning prerelease syntax, for example
`1.1.0-rc.1`, and must set `releaseChannel: "prerelease"` in the release plan.

Release-candidate publication follows the same exact-SHA production chain as a stable release,
but GitHub must mark the resulting Release as a **prerelease**. Before any tag or Release is
created, the workflow checks the repository immutable-releases setting and refuses publication
unless it is enabled. After publication, the workflow verifies both `prerelease=true` and
`immutable=true` on the created Release.

A prerelease candidate is intended for owner canary / controlled verification. It is not the
stable `v1.1.0` product release.

Publication also requires the repository Actions secret `PJSDAS_RELEASE_ADMIN_TOKEN`.
It must be a narrowly scoped GitHub token that can **read repository Administration
settings** so the workflow can verify default-branch protection and Immutable Releases
before using the normal workflow `GITHUB_TOKEN` to create the tag/Release. The admin
token is not used for source writes or release creation.

## Gateway runtime version

The authenticated MCP gateway has its own runtime / compatibility version. At the `v1.0.0` product release this remains `1.9.0-alpha.1`.

That identifier may change independently when the gateway transport, protocol compatibility contract, or runtime surface requires a version change. It is not the public product SemVer and must not be bumped merely to make version strings visually identical.

## Deployed build identity

The authoritative identity of a deployed frontend/backend pair is the exact Git commit SHA.

The backend exposes this through `/api/health.release.commitSha`. GitHub Pages refuses to publish unless a configured production backend advertises the exact same SHA and the required capability/tool-surface contract.

A version number identifies a release line. The commit SHA identifies the exact deployed build. `main` may advance after a formal release; the release tag continues to identify the verified release commit.

## Release gate

A public release may be created only after the same commit has passed, in order:

1. CI: dependency audit, unit/regression/reliability tests, TypeScript/Vite production build;
2. Browser E2E critical journeys;
3. production backend deployment for the exact commit SHA;
4. backend health/capability and MCP release-tool-surface verification;
5. anonymous authentication-boundary checks;
6. GitHub Pages build and deployment;
7. post-deploy Production Self-Test.

The GitHub Release workflow is triggered by a successful Production Self-Test. It reads `.github/release-plan.json`, verifies that the armed plan matches `package.json`, and creates a version-pinned Git tag and GitHub Release for the verified commit. Re-running the workflow is idempotent when the release already exists, and an existing orphan tag is never moved or reused.

## Release plan lifecycle

`.github/release-plan.json` is the explicit publication intent for the next formal release.

A release plan contains:

- `publicVersion`;
- `tag`;
- `engineeringMilestone`;
- `releaseNotes`;
- `publishOnProductionSuccess`.

`publishOnProductionSuccess` is an arming switch:

- set it to `true` only when the listed version is intentionally ready to publish after the production chain passes;
- after that release is successfully published and verified, set it back to `false` so ordinary post-release development does not repeatedly enter release-publication logic;
- before a later public release, update the package version, release plan, release notes, and associated regression expectations together, then re-arm publication.

Do not reuse an existing release tag for a different commit.

## GitHub platform release immutability

GitHub's repository-level **Immutable Releases** setting is a separate supply-chain control. When enabled before publication, GitHub locks the published release assets and associated tag and creates a release attestation.

PJSDAS `v1.0.0` was published before that repository setting was enabled, so GitHub reports the release as `immutable=false`. GitHub applies release immutability only to future releases; this does not change the verified commit identity, release tag target, deployment state, or product correctness of `v1.0.0`.

Platform-level immutability is therefore not inferred from the PJSDAS release workflow. The workflow's refusal to move or reuse a tag is an application-level safety rule, not a substitute for GitHub's Immutable Releases feature.

For `v1.0.1` and later releases, repository-level release immutability should be enabled before publication. After publication, verify the release reports `immutable=true` and has the expected release attestation.

## Current mapping

For the `v1.1.0-rc.1` release candidate:

| Identifier | Meaning | Value |
| --- | --- | --- |
| Public product version | Owner-canary release candidate | `v1.1.0-rc.1` |
| `package.json` | Application package version | `1.1.0-rc.1` |
| Git tag | Version-pinned source release marker | `v1.1.0-rc.1` |
| Release channel | GitHub release classification | `prerelease` |
| Engineering milestone | Current internal development/hardening stream | `PJSDAS-AI-OPERATED-PRODUCTION-v1 / Round 5` |
| Authenticated gateway runtime | MCP runtime compatibility contract | `1.9.0-alpha.1` |
| Production build identity | Exact deployed frontend/backend revision | Git commit SHA |
| GitHub platform immutability for v1.0.0 | Historical release published before repository immutability was enabled | `false` |
| GitHub platform immutability for v1.0.1 | Required repository-level publication gate | verify `immutable=true` after publication |
