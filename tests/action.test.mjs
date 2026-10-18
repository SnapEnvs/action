import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiOrigin, parseImages, repositoryPath, runAction } from '../index.mjs'

const image = `registry.example.test/team/web@sha256:${'a'.repeat(64)}`
const project = '12345678-1234-1234-1234-123456789012'
const sha = 'a'.repeat(40)
const plan = {
  id: 'execution',
  revision: 7,
  repository: 'frontend',
  branch: 'preview/test',
  commitSha: sha,
  sequence: 42,
  services: [{ name: 'web', context: '.', dockerfile: 'Dockerfile', target: '' }],
}
const deployed = {
  id: 'environment',
  generation: 3,
  observedGeneration: 3,
  observedState: 'RUNNING',
  previewUrl: 'https://preview.example.test',
}
function fixture(overrides = {}) {
  let time = Date.parse('2026-01-01T00:00:00Z')
  let exchanges = 0
  const calls = []
  const environment = {
    INPUT_PROJECT: project,
    INPUT_IMAGES: `web=${image}`,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/preview/test',
    GITHUB_SHA: sha,
    ACTIONS_ID_TOKEN_REQUEST_URL:
      'https://example.actions.githubusercontent.com/token?existing=value',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
    ...overrides,
  }
  const respond = (body, status = 200) =>
    new Response(
      JSON.stringify(
        body.environment ? { deploymentGeneration: body.environment.generation, ...body } : body,
      ),
      { status },
    )
  const routes = new Map([
    ['/api/v1/ci/github/plan', () => respond(plan)],
    ['/api/v1/ci/github/releases', () => respond({ environment: deployed }, 202)],
    ['/api/v1/ci/environments/environment', () => respond(deployed)],
    [
      '/api/v1/ci/registry',
      () =>
        respond({
          host: 'registry.example.test',
          username: 'pipeline',
          imagePrefix: 'registry.example.test/team',
        }),
    ],
    ['/api/v1/ci/build-failures', () => respond({ accepted: true })],
  ])
  const fetchImpl = async (input, options) => {
    const url = new URL(input)
    calls.push({ url, ...options, body: options.body && JSON.parse(options.body) })
    if (url.hostname.endsWith('.actions.githubusercontent.com')) {
      assert.equal(url.searchParams.get('audience'), 'https://snapenvs.com')
      assert.equal(options.headers.Authorization, 'Bearer request-secret')
      return respond({ value: 'signed-identity' })
    }
    if (url.pathname.endsWith('/token/exchange')) {
      exchanges++
      return respond({
        token: `credential-${exchanges}`,
        expiresAt: new Date(time + 300000).toISOString(),
      })
    }
    assert.equal(options.headers.Authorization, `Bearer credential-${exchanges}`)
    assert.equal(options.redirect, 'error')
    const route = routes.get(url.pathname)
    assert.ok(route, `Unexpected API request ${url.pathname}`)
    return route(options)
  }
  return {
    environment,
    calls,
    routes,
    respond,
    fetchImpl,
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    advance: (ms) => {
      time += ms
    },
    exchanges: () => exchanges,
  }
}

test('deploy-only uses OIDC DEPLOY, sends only images and run ID, and exports outputs after readiness', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'snapenvs-action-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const f = fixture({ GITHUB_OUTPUT: join(directory, 'output') })
  f.routes.set('/api/v1/ci/github/releases', () =>
    f.respond(
      { environment: { ...deployed, observedGeneration: 2, observedState: 'PENDING' } },
      202,
    ),
  )
  const outputs = await runAction({ ...f, exec: () => assert.fail('Deploy-only must not build') })
  assert.equal(outputs['preview-url'], deployed.previewUrl)
  assert.equal(outputs['configuration-revision'], '7')
  const released = f.calls.find((c) => c.url.pathname.endsWith('/github/releases'))
  assert.deepEqual(released.body, { runId: 'execution', images: { web: image } })
  assert.equal(
    f.calls.find((c) => c.url.pathname.endsWith('/token/exchange')).body.purpose,
    'DEPLOY',
  )
  assert.equal(f.exchanges(), 1)
  assert.match(
    await readFile(f.environment.GITHUB_OUTPUT, 'utf8'),
    /preview-url<<[^\n]+\nhttps:\/\/preview.example.test/,
  )
})

test('build mode publishes multiple immutable digests, renews expired credentials, and removes Docker auth', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'snapenvs-action-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'Dockerfile'), 'FROM scratch\n')
  await mkdir(join(directory, 'worker'))
  await writeFile(join(directory, 'worker/Dockerfile'), 'FROM scratch\n')
  const f = fixture({ INPUT_IMAGES: '', GITHUB_WORKSPACE: directory })
  f.routes.set('/api/v1/ci/github/plan', () =>
    f.respond({
      ...plan,
      services: [
        ...plan.services,
        {
          name: 'worker',
          context: 'worker',
          dockerfile: 'worker/Dockerfile',
          target: 'production',
        },
      ],
    }),
  )
  const commands = []
  let dockerConfig
  const outputs = await runAction({
    ...f,
    exec: async (command, args, options) => {
      assert.equal(command, 'docker')
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined)
      assert.equal(options.env.INPUT_PROJECT, undefined)
      dockerConfig = options.env.DOCKER_CONFIG
      commands.push(args)
      if (args[0] === 'build') f.advance(360000)
      if (args[0] === 'login') assert.equal(options.input, `credential-${f.exchanges()}`)
      if (args[0] === 'image')
        return JSON.stringify([`${args[2].split(':run-')[0]}@sha256:${'a'.repeat(64)}`])
      return ''
    },
  })
  assert.equal(outputs['deployment-skipped'], 'false')
  assert.equal(f.exchanges(), 3)
  assert.equal(
    f.calls.find((c) => c.url.pathname.endsWith('/token/exchange')).body.purpose,
    'PIPELINE',
  )
  assert.deepEqual(
    commands.map((c) => c[0]),
    ['build', 'login', 'push', 'image', 'build', 'login', 'push', 'image'],
  )
  assert.ok(commands[4].includes('production'))
  assert.equal(
    Object.keys(f.calls.find((c) => c.url.pathname.endsWith('/github/releases')).body.images)
      .length,
    2,
  )
  await assert.rejects(access(dockerConfig), { code: 'ENOENT' })
})

test('build failures are redacted, reported with the reserved sequence, and never deploy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'snapenvs-action-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'Dockerfile'), 'FROM scratch\n')
  const f = fixture({ INPUT_IMAGES: '', GITHUB_WORKSPACE: directory })
  let dockerConfig
  await assert.rejects(
    runAction({
      ...f,
      exec: async (cmd, args, options) => {
        dockerConfig = options.env.DOCKER_CONFIG
        throw Object.assign(new Error('Build failed'), {
          output: 'request-secret credential-1 signed-identity password=unsafe-value',
        })
      },
    }),
    /Build failed/,
  )
  const failure = f.calls.find((c) => c.url.pathname.endsWith('/build-failures')).body
  assert.equal(failure.sequence, 42)
  assert.equal(failure.commitSha, sha)
  assert.doesNotMatch(failure.logs, /request-secret|credential-1|signed-identity|unsafe-value/)
  assert.ok(!f.calls.some((c) => c.url.pathname.endsWith('/github/releases')))
  await assert.rejects(access(dockerConfig), { code: 'ENOENT' })
})

test('a lost release response retries the identical run and images', async () => {
  const f = fixture()
  let attempts = 0
  f.routes.set('/api/v1/ci/github/releases', () => {
    if (++attempts === 1) throw new Error('Connection reset after acceptance')
    return f.respond({ environment: deployed })
  })
  await runAction(f)
  const releases = f.calls.filter((c) => c.url.pathname.endsWith('/github/releases'))
  assert.equal(releases.length, 2)
  assert.deepEqual(releases[0].body, releases[1].body)
})

test('readiness polling accepts a one-second interval and rejects invalid bounds before exchanging identity', async () => {
  const f = fixture({ 'INPUT_WAIT-INTERVAL': '1' })
  f.routes.set('/api/v1/ci/github/releases', () =>
    f.respond({ environment: { ...deployed, observedState: 'PENDING' } }),
  )
  const start = f.now()
  await runAction(f)
  assert.equal(f.now() - start, 1000)
  for (const value of ['0', '31', '0.5', 'invalid']) {
    const invalid = fixture({ 'INPUT_WAIT-INTERVAL': value })
    await assert.rejects(runAction(invalid), /wait-interval/)
    assert.equal(invalid.calls.length, 0)
  }
})

test('an idempotent retry cannot report a later deployment as its own successful generation', async () => {
  const f = fixture()
  f.routes.set('/api/v1/ci/github/releases', () =>
    f.respond({
      environment: { ...deployed, generation: 4, observedGeneration: 4 },
      deploymentGeneration: 3,
    }),
  )
  await assert.rejects(runAction(f), /superseded/)
})

test('renews unauthorized credentials and respects deploymentSkipped', async () => {
  const f = fixture()
  let attempts = 0
  f.routes.set('/api/v1/ci/github/plan', () =>
    ++attempts === 1 ? f.respond({}, 401) : f.respond(plan),
  )
  f.routes.set('/api/v1/ci/github/releases', () =>
    f.respond({
      environment: { ...deployed, observedState: 'UNAVAILABLE' },
      deploymentSkipped: true,
    }),
  )
  assert.equal((await runAction(f))['deployment-skipped'], 'true')
  assert.equal(f.exchanges(), 2)
  assert.ok(!f.calls.some((c) => c.url.pathname.includes('/environments/')))
})

test('fails when readiness is superseded, fails, or times out', async () => {
  for (const [state, generation, error] of [
    ['RUNNING', 4, /superseded/],
    ['FAILED', 3, /Deployment failed/],
    ['PENDING', 3, /Timed out/],
  ]) {
    const f = fixture({ 'INPUT_WAIT-SECONDS': '1' })
    f.routes.set('/api/v1/ci/github/releases', () =>
      f.respond({ environment: { ...deployed, observedState: 'PENDING', observedGeneration: 2 } }),
    )
    f.routes.set('/api/v1/ci/environments/environment', () =>
      f.respond({ ...deployed, observedState: state, generation }),
    )
    await assert.rejects(runAction(f), error)
  }
})

test('rejects mismatched identities, service lists, unsupported events and insecure endpoints before deployment', async () => {
  for (const overrides of [
    { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_REF: 'refs/heads/other' },
    { INPUT_IMAGES: `worker=${image}` },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { 'INPUT_API-URL': 'http://example.com' },
    { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.example/token' },
  ]) {
    const f = fixture(overrides)
    await assert.rejects(runAction(f))
    assert.ok(!f.calls.some((c) => c.url.pathname.endsWith('/github/releases')))
  }
})

test('build paths cannot escape through traversal or symlinks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'snapenvs-action-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'repo'))
  await writeFile(join(directory, 'outside'), 'private')
  await symlink('../outside', join(directory, 'repo/Dockerfile'))
  for (const path of ['../outside', '/etc/passwd', '$(command)', 'Dockerfile'])
    await assert.rejects(repositoryPath(join(directory, 'repo'), path), /inside the repository/)
})

test('validates digest inputs and API origin', () => {
  for (const value of [
    'web=registry/app:latest',
    `web=${image}\nweb=${image}`,
    `bad name=${image}`,
  ])
    assert.throws(() => parseImages(value))
  for (const value of [
    'https://user:secret@example.test',
    'https://example.test/api',
    'https://example.test/?key=secret',
  ])
    assert.throws(() => apiOrigin(value))
  assert.equal(apiOrigin('http://localhost:8080'), 'http://localhost:8080')
})
