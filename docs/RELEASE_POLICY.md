# PJSDAS Release and Version Policy

PJSDAS distinguishes product releases, engineering milestones, runtime compatibility versions, and deployed build identity. These identifiers serve different purposes and must not be mechanically forced to match.

## Public product version

The first formal public product release is `v1.0.0`.

From this release onward:

- the public product version follows Semantic Versioning;
- `package.json` must carry the same numeric version as the public product release;
- the Git tag is `v<package version>`;
- the GitHub Release title uses the same public product version;
- a public release is created only from a commit that has completed the production release chain.

`v1.9`, `v1.10`, and similar labels already present in historical design and hardening documents are engineering milestones. They describe implementation rounds and product-development workstreams; they are not retroactively reinterpreted as public SemVer releases.

## Gateway runtime version

The authenticated MCP gateway has its own runtime / compatibility version. At the `v1.0.0` product release this remains `1.9.0-alpha.1`.

That identifier may change independently when the gateway transport, protocol compatibility contract, or runtime surface requires a version change. It is not the public product SemVer and must not be bumped merely to make version strings visually identical.

## Deployed build identity

The authoritative identity of a deployed frontend/backend pair is the exact Git commit SHA.

The backend exposes this through `/api/health.release.commitSha`. GitHub Pages refuses to publish unless a configured production backend advertises the exact same SHA and the required capability/tool-surface contract.

A version number identifies a release line. The commit SHA identifies the exact deployed build.

## Release gate

A public release may be created only after the same commit has passed, in order:

1. CI: dependency audit, unit/regression/reliability tests, TypeScript/Vite production build;
2. Browser E2E critical journeys;
3. production backend deployment for the exact commit SHA;
4. backend health/capability and MCP release-tool-surface verification;
5. anonymous authentication-boundary checks;
6. GitHub Pages build and deployment;
7. post-deploy Production Self-Test.

The GitHub Release workflow is triggered by a successful Production Self-Test. It reads `.github/release-plan.json`, verifies that the plan matches `package.json`, and creates the immutable tag/release for the verified commit. Re-running the workflow is idempotent when the release already exists.

## Release plan

`.github/release-plan.json` is the explicit publication intent for the next formal release.

A release plan contains:

- `publicVersion`;
- `tag`;
- `engineeringMilestone`;
- `releaseNotes`;
- `publishOnProductionSuccess`.

Before starting a later public release, update the package version, release plan, release notes, and associated regression expectations together. Do not reuse an existing release tag for a different commit.

## Current mapping

For the first formal release:

| Identifier | Meaning | Value |
| --- | --- | --- |
| Public product version | User-facing immutable release | `v1.0.0` |
| `package.json` | Application package version | `1.0.0` |
| Git tag | Immutable source release marker | `v1.0.0` |
| Engineering milestone | Current internal development/hardening stream | `v1.10` |
| Authenticated gateway runtime | MCP runtime compatibility contract | `1.9.0-alpha.1` |
| Production build identity | Exact deployed frontend/backend revision | Git commit SHA |
