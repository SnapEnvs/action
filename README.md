# SnapEnvs for GitHub Actions

Build images on your GitHub runner and deploy previews using configuration stored in SnapEnvs. Your application repository needs a Dockerfile and a workflow. It does not need `snapenvs.json`, a copied JavaScript client, cluster credentials or a long-lived SnapEnvs token.

## Set up in SnapEnvs

1. Add the GitHub repository to a project with its immutable repository/owner IDs, trusted branches, base branch and service names.
2. For automatic builds, enable image publication for that repository and choose an enabled default registry space for the organization.
3. Under **Pipeline integration**, select the project and repository. Save build context, Dockerfile, optional build target, port, health path, resources, runtime variables and migration command for every service. Paths are relative to the repository root. Store secrets in the project's Secrets tab and reference them with `secret:NAME`.
4. Configure project add-ons and lifetime in SnapEnvs. Copy the generated workflow into `.github/workflows/preview.yml` in the application repository, including the default branch. Its published workflow reference is pinned to a full commit SHA.

The reusable workflow uses an Ubuntu GitHub-hosted runner billed to the caller. Each service builds sequentially with Docker, pushes to the SnapEnvs registry, and deploys the resulting immutable digest. No `secrets: inherit` is needed. Your repository/organization's Actions policy must allow this Action and reusable workflow.

## Use the Action with an existing build

Keep your build, registry login and cache steps. Add a deployment step with one immutable image per configured service:

```yaml
permissions:
  contents: read
  id-token: write

# Inside your existing job, after building and publishing:
steps:
  # ... your build steps ...
  - uses: OWNER/REPOSITORY@FULL_ACTION_COMMIT_SHA
    id: preview
    with:
      project: YOUR_PROJECT_UUID
      api-url: https://snapenvs.com
      images: |
        web=${{ steps.build.outputs.web-image }}
        worker=${{ steps.build.outputs.worker-image }}
```

Replace the Action reference with the published repository and its full commit SHA. Each image output must be a complete `registry/path@sha256:<64 hex characters>` reference. The runtime must have its own pull access to external registries. Supplying `images` skips checkout/build/publication in this Action and requests only `DEPLOY` authority. Without `images`, use `actions/checkout` before the Action; Docker is required.

| Input          | Default                | Meaning                                                                       |
| -------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `project`      | required               | SnapEnvs project UUID                                                         |
| `api-url`      | `https://snapenvs.com` | API origin, HTTPS except loopback for local tests                             |
| `images`       | empty                  | One `service=immutable-image` per line; empty builds every configured service |
| `wait`         | `true`                 | Wait for the accepted generation to become ready                              |
| `wait-seconds` | `600`                  | Readiness deadline, 1–3600 seconds                                            |

Outputs: `environment-id`, `preview-url`, `configuration-revision`, `deployment-skipped`. A partial release can be accepted with `deployment-skipped: true` when another required service has not been published yet; this is not a running preview.

## Trust, retries and lifecycle

Only repository-owned `push` and `workflow_dispatch` jobs on trusted branch refs are accepted. Fork PRs, `pull_request`, `pull_request_target` and tags are rejected. Anyone allowed to push a trusted branch can publish its previews. OIDC binds the run ID, attempt, repository identity, branch and commit; using a reusable workflow is not an additional authorization boundary.

The first plan request pins an immutable service configuration and project lifetime for that run attempt. Retries reuse it and the same server-assigned ordering sequence. Edits during a build apply to the next execution; GitHub **Re-run jobs** creates a new attempt and selects the latest configuration. Repeating the same release is idempotent; submitting different digests for the same attempt is a conflict. Once a newer sequence has been accepted for a repository/branch, an older release cannot replace it. Avoid two independently different releases from the same repository/project in the same GitHub run attempt.

The build plan contains build paths; runtime variables and project secrets are not injected into Docker builds. The existing release/status API can return the environment specification, including variable references, but never resolves project secrets for the runner. Credentials renew before expiry and immediately before publication after a long build. Docker credentials are stored in a temporary isolated directory and removed afterward. A bounded, redacted build failure is reported to SnapEnvs.

Previews expire using the project's lifetime. Sleep, wake and early destruction remain available in SnapEnvs. Automatic PR comments, PR close/delete-branch cleanup, build arguments/secrets, remote build contexts, multi-platform builds and custom registry authentication are not provided by the default reusable workflow. Use your own build plus `images` for advanced builds. The standalone Action can run on a trusted runner with Node 24 Action support; automatic build mode requires Linux with Docker. The default workflow runs on `ubuntu-24.04`.

## Development

This directory is the distribution source. The application repository's `docs/github-actions.md` describes packaging and publication; `scripts/package-github-integration.mjs` assembles the standalone Action and reusable workflow without publishing them. Tests run with `npm run test:github` in the application repository.

GitHub references: [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax), [OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).
