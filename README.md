# SnapEnvs for GitHub Actions

Build images on your GitHub runner and deploy previews using configuration stored in SnapEnvs. Your application repository needs a Dockerfile and a workflow. It does not need `snapenvs.json`, a copied JavaScript client, cluster credentials or a long-lived SnapEnvs token.

## Set up in SnapEnvs

1. Add the GitHub repository to a project with its immutable repository/owner IDs, trusted branches, base branch and service names.
2. For automatic builds, enable image publication for that repository and choose an enabled default registry space for the organization.
3. Under **Projects → your project → Pipeline**, select the repository. Save build context, Dockerfile, optional build target, port, health path, resources, runtime variables and migration command for every service. Paths are relative to the repository root. Store secrets in the project's Secrets tab and reference them with `secret:NAME`.
4. Configure project add-ons and lifetime in SnapEnvs. Copy the generated workflow into `.github/workflows/preview.yml` in the application repository, including the default branch. Its published workflow reference is pinned to a full commit SHA.

The reusable workflow uses an Ubuntu GitHub-hosted runner billed to the caller. Before building, it removes preinstalled toolchains the build does not use (Android SDK, .NET, GHC, CodeQL) and the runner's cached images; pass `free-runner-disk: false` to skip this. Each service builds sequentially with Docker, pushes to the SnapEnvs registry, and deploys the resulting immutable digest. After each push the Action removes the published image and the Docker build cache from the runner, so several services fit the GitHub-hosted disk. No `secrets: inherit` is needed. Your repository/organization's Actions policy must allow this Action and reusable workflow.

## Use the Action with an existing build

Keep your build and cache steps. Authenticate a custom publisher with the official `registry-auth` companion, then deploy one immutable image per configured service:

```yaml
permissions:
  contents: read
  id-token: write

# Inside your existing job:
steps:
  # ... checkout, tool installation and build steps ...
  - uses: SnapEnvs/action/registry-auth@f531b6996d949e59fd0a2c66807a8eb38b1a044e
    id: registry
    with:
      project: YOUR_PROJECT_UUID
  # ... publish with Docker or crane using the exported DOCKER_CONFIG ...
  # The image path starts with steps.registry.outputs.image-prefix.
  # Pass immutable digests from your publisher to the deployment step.
  - uses: SnapEnvs/action@f531b6996d949e59fd0a2c66807a8eb38b1a044e
    id: preview
    with:
      project: YOUR_PROJECT_UUID
      api-url: https://snapenvs.com
      images: |
        web=${{ steps.build.outputs.web-image }}
        worker=${{ steps.build.outputs.worker-image }}
```

Both Action references must use a published full commit SHA. Each image output must be a complete `registry/path@sha256:<64 hex characters>` reference. For an external registry, keep your own login step; the runtime must have its own pull access. Supplying `images` skips checkout/build/publication in this Action and requests only `DEPLOY` authority. Without `images`, use `actions/checkout` before the Action; Docker is required.

| Input          | Default                | Meaning                                                                       |
| -------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `project`      | required               | SnapEnvs project UUID                                                         |
| `api-url`      | `https://snapenvs.com` | API origin, HTTPS except loopback for local tests                             |
| `images`       | empty                  | One `service=immutable-image` per line; empty builds every configured service |
| `wait`         | `true`                 | Wait for the accepted generation to become ready                              |
| `wait-seconds` | `600`                  | Readiness deadline, 1–3600 seconds                                            |
| `reclaim-disk` | `true`                 | Remove the published image and build cache from the runner after each push    |

Outputs: `environment-id`, `preview-url`, `configuration-revision`, `deployment-skipped`. A partial release can be accepted with `deployment-skipped: true` when another required service has not been published yet; this is not a running preview.

## Registry authentication for custom publishers

`SnapEnvs/action/registry-auth` accepts `project` and `api-url` (default `https://snapenvs.com`). It exchanges GitHub OIDC for `IMAGE_PUBLISH` authority and selects the organization's enabled default registry space. Enable image publication on the configured GitHub source, with the same immutable repository/owner IDs and trusted branch requirements used by the deployment Action.

The companion exports `DOCKER_CONFIG` for subsequent steps and returns `host`, `image-prefix`, `username` and `expires-at`. It never exports the credential as an Action output. Docker and crane read the isolated configuration automatically; no copied API client or stored SnapEnvs token is needed. Existing Docker credentials are preserved. A post action removes the temporary credential directory, including after a failed publication.

Run authentication immediately before publication. The credential is bounded by the GitHub OIDC expiry and at most 15 minutes. It does not refresh in the background: invoke the companion again immediately before a later publication if necessary. Only trusted later steps may read the configuration; do not upload/cache that directory. Registry authentication does not deploy or create a pipeline plan. The deployment Action requests its own `DEPLOY` identity and uses the saved service configuration.

The standalone deployment Action also accepts `wait-interval` from 1 to 30 seconds (default 2). Set `wait-interval: 1` when a faster readiness check is useful. This changes polling only; it does not change application health checks.

## Publish application files over a cached runtime

`SnapEnvs/action/publish-image` provides the fast path for applications that do not need compilation. It installs checksum-pinned crane 0.22.1, appends one deterministic application layer to a remote runtime digest, and pushes an immutable image. It uses the preceding `registry-auth` step's `DOCKER_CONFIG`; it does not request credentials or deploy by itself.

Replace `FULL_PUBLISHED_COMMIT_SHA` below with the same full published Action commit in all three steps:

```yaml
steps:
  # Check out the dispatched commit and run your application's tests first.
  - uses: SnapEnvs/action/registry-auth@FULL_PUBLISHED_COMMIT_SHA
    id: registry
    with:
      project: YOUR_PROJECT_UUID
  - uses: SnapEnvs/action/publish-image@FULL_PUBLISHED_COMMIT_SHA
    id: image
    with:
      image: ${{ steps.registry.outputs.image-prefix }}/app
      files: |
        app
        web
        migrations
        gunicorn.conf.py
        release.json
      env: |
        DEMO_COMMIT=${{ github.sha }}
        DEMO_BRANCH=${{ github.ref_name }}
  - uses: SnapEnvs/action@FULL_PUBLISHED_COMMIT_SHA
    with:
      project: YOUR_PROJECT_UUID
      images: app=${{ steps.image.outputs.image }}
      wait-interval: '1'
```

| Input | Default | Meaning |
| --- | --- | --- |
| `image` | required | Registry repository without a tag or digest |
| `context` | `.` | Source directory inside the checked-out repository |
| `files` | required | One relative file or directory per line, without globs |
| `runtime-key-files` | `Dockerfile`, `requirements.txt` | Ordered runtime build inputs, one per line; must include `Dockerfile` |
| `destination` | `/app` | Application directory inside the image |
| `uid` / `gid` | `10001` / `10001` | Application file ownership |
| `env` | empty | One non-secret `KEY=value` image configuration entry per line |

The Dockerfile must have a `runtime` target that contains the dependencies, user, command and other runtime settings. Application files are copied by this companion, so instructions in subsequent Dockerfile stages are not executed. Pin base images by digest and list **every file used by the runtime target** in `runtime-key-files`. Otherwise dependency changes cannot invalidate the cache. Changing their order also changes the cache key. Cache keys preserve the original light-demo publisher's `Dockerfile`/`requirements.txt` format.

A missing runtime manifest triggers `docker build --platform linux/amd64 --target runtime` and a push once. Authentication or transport failures stop publication instead of rebuilding. Every application release starts from the runtime digest, so layers do not accumulate. Source files are sorted and copied with mode `0644`, the configured ownership and a zero timestamp; executable files, symlinks and arbitrary build steps are outside this fast path. Git metadata, `.env` files and symlinks are rejected; Python bytecode is omitted. Only select files safe to publish: this is an allowlist, not a general secret scanner.

Outputs are `image`, `digest`, `seconds` and `runtime-cache-miss`. JSON log metrics include runtime lookup/build time, layer bytes and push time. `seconds` excludes crane installation; use the entire Action step and workflow timestamps for customer-facing latency. The companion requires Linux amd64, Python 3.12+, curl, tar and Docker for a cache miss; `ubuntu-24.04` supplies these tools. No Python packages, Node packages or copied publisher script are needed in the application repository.

## Trust, retries and lifecycle

Only repository-owned `push` and `workflow_dispatch` jobs on trusted branch refs are accepted. Fork PRs, `pull_request`, `pull_request_target` and tags are rejected. Anyone allowed to push a trusted branch can publish its previews. OIDC binds the run ID, attempt, repository identity, branch and commit; using a reusable workflow is not an additional authorization boundary.

The first plan request pins an immutable service configuration and project lifetime for that run attempt. Retries reuse it and the same server-assigned ordering sequence. Edits during a build apply to the next execution; GitHub **Re-run jobs** creates a new attempt and selects the latest configuration. Repeating the same release is idempotent; submitting different digests for the same attempt is a conflict. Once a newer sequence has been accepted for a repository/branch, an older release cannot replace it. Avoid two independently different releases from the same repository/project in the same GitHub run attempt.

The build plan contains build paths; runtime variables and project secrets are not injected into Docker builds. The existing release/status API can return the environment specification, including variable references, but never resolves project secrets for the runner. Credentials renew before expiry and immediately before publication after a long build. Docker credentials are stored in a temporary isolated directory and removed afterward. A bounded, redacted build failure is reported to SnapEnvs.

Previews expire using the project's lifetime. Sleep, wake and early destruction remain available in SnapEnvs. Automatic PR comments, PR close/delete-branch cleanup, build arguments/secrets, remote build contexts, multi-platform builds and custom registry authentication are not provided by the default reusable workflow. Use your own build plus `images` for advanced builds. The standalone Action can run on a trusted runner with Node 24 Action support; automatic build mode requires Linux with Docker. The default workflow runs on `ubuntu-24.04`.

## Development

This directory is the distribution source. The application repository's `docs/github-actions.md` describes packaging and publication; `scripts/package-github-integration.mjs` assembles the deployment Action, registry authentication and image publishing companions, tests and reusable workflow without publishing them. Tests run with `npm run test:github` in the application repository, including the Python publisher suite and the isolated standalone distribution tests.

GitHub references: [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax), [OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).

## Named CI destinations

Choose **CI destination** in the project pipeline page. Automatic branch preview remains the
legacy default. Selecting `dev` or `staging` saves that exact environment ID with the
configuration revision. The official published workflow needs no new input or client update.
Each run keeps its original destination, including retries and configuration edits while it
builds. A destroyed or inaccessible target fails; its name is never used to find a replacement.
Only the selected environment is redeployed. Its private access, wake policy, deadline and
persistent add-ons remain in place. See [named environments](../../docs/named-environments.md).
