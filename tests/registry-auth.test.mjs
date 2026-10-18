import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registryAuth } from '../registry-auth/index.mjs'
import { cleanup } from '../registry-auth/post.mjs'

function values(content) {
  const result = {}
  const lines = content.trimEnd().split('\n')
  for (let i = 0; i < lines.length;) {
    const [key, delimiter] = lines[i++].split('<<')
    const value = []
    while (lines[i] !== delimiter && i < lines.length) value.push(lines[i++])
    i++
    result[key] = value.join('\n')
  }
  return result
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'snapenvs-auth-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const environment = {
    INPUT_PROJECT: '12345678-1234-1234-1234-123456789012',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/demo',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://test.actions.githubusercontent.com/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-secret',
    GITHUB_ENV: join(root, 'env'),
    GITHUB_OUTPUT: join(root, 'output'),
    GITHUB_STATE: join(root, 'state'),
    DOCKER_CONFIG: join(root, 'existing-docker'),
  }
  const calls = []
  const registry = {
    host: 'registry.example.test',
    imagePrefix: 'registry.example.test/team/source',
    username: 'pipeline',
  }
  const fetchImpl = async (url, options) => {
    const target = new URL(url)
    calls.push({ target, ...options })
    let body
    if (target.hostname.endsWith('.actions.githubusercontent.com')) {
      assert.equal(target.searchParams.get('audience'), 'https://snapenvs.com')
      body = { value: 'signed-identity' }
    } else if (target.pathname.endsWith('/token/exchange')) {
      assert.equal(JSON.parse(options.body).purpose, 'IMAGE_PUBLISH')
      body = { token: 'short-lived-credential', expiresAt: '2026-10-18T06:05:00Z' }
    } else {
      assert.equal(target.pathname, '/api/v1/ci/registry')
      assert.equal(options.headers.Authorization, 'Bearer short-lived-credential')
      body = registry
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  return {
    root,
    environment,
    registry,
    calls,
    fetchImpl,
    now: () => Date.parse('2026-10-18T06:00:00Z'),
  }
}

test('registry auth exports scoped metadata and isolated Docker/crane config, then cleans it without touching existing credentials', async (t) => {
  const f = await fixture(t)
  await writeFile(f.environment.DOCKER_CONFIG, 'existing credentials')
  const outputs = await registryAuth(f)
  const exported = values(await readFile(f.environment.GITHUB_ENV, 'utf8'))
  const state = values(await readFile(f.environment.GITHUB_STATE, 'utf8'))
  const directory = exported.DOCKER_CONFIG
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
  assert.equal(
    Buffer.from(config.auths[f.registry.host].auth, 'base64').toString(),
    'pipeline:short-lived-credential',
  )
  assert.equal((await stat(join(directory, 'config.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal(state.snapenvsDockerConfig, directory)
  assert.equal(outputs['image-prefix'], f.registry.imagePrefix)
  assert.equal(outputs['expires-at'], '2026-10-18T06:05:00Z')
  assert.doesNotMatch(
    await readFile(f.environment.GITHUB_OUTPUT, 'utf8'),
    /credential|signed-identity|oidc-request-secret/,
  )
  await cleanup({
    environment: {
      ...f.environment,
      DOCKER_CONFIG: directory,
      STATE_snapenvsDockerConfig: directory,
      STATE_previousDockerConfig: state.previousDockerConfig,
    },
  })
  await assert.rejects(access(directory), { code: 'ENOENT' })
  assert.equal(
    values(await readFile(f.environment.GITHUB_ENV, 'utf8')).DOCKER_CONFIG,
    f.environment.DOCKER_CONFIG,
  )
  assert.equal(await readFile(f.environment.DOCKER_CONFIG, 'utf8'), 'existing credentials')
})

test('registry auth rejects untrusted events and malicious registry output before exporting credentials', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    registryAuth({ ...f, environment: { ...f.environment, GITHUB_EVENT_NAME: 'pull_request' } }),
    /trusted branch/,
  )
  assert.equal(f.calls.length, 0)
  f.registry.imagePrefix += '\nINJECTED=value'
  await assert.rejects(registryAuth(f), /invalid registry metadata/)
  await assert.rejects(access(f.environment.GITHUB_ENV), { code: 'ENOENT' })
})

test('registry auth removes credentials when writing outputs fails', async (t) => {
  const f = await fixture(t)
  f.environment.GITHUB_OUTPUT = join(f.root, 'missing', 'output')
  await assert.rejects(registryAuth(f), /ENOENT/)
  const state = values(await readFile(f.environment.GITHUB_STATE, 'utf8'))
  await assert.rejects(access(state.snapenvsDockerConfig), { code: 'ENOENT' })
})

test('post cleanup cannot remove an unrelated directory and tolerates a failed setup', async (t) => {
  const f = await fixture(t)
  await cleanup({ environment: {} })
  await assert.rejects(
    cleanup({ environment: { STATE_snapenvsDockerConfig: f.root } }),
    /Refusing to remove/,
  )
  assert.ok(await stat(f.root))
})
