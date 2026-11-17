import { writeFile, mkdir, appendFile, mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createClient, redact } from './client.mjs'
export { apiOrigin } from './client.mjs'

const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]{0,220}@sha256:[a-f0-9]{64}$/

function buildArguments(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 40)
    throw new Error('Invalid build arguments.')
  return Object.entries(args).map(([name, value]) => {
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(name) ||
      typeof value !== 'string' ||
      value.length > 2000 ||
      /[\0\r\n]/.test(value) ||
      /^(?:secret|addon|environment):/.test(value)
    )
      throw new Error('Build arguments must be literal single-line values.')
    return [name, value]
  })
}
function keycloakDockerfile(providers, sourceImage) {
  if (
    !providers ||
    !imagePattern.test(providers.baseImage ?? '') ||
    !/^\/[a-zA-Z0-9_/-]+$/.test(providers.path ?? '') ||
    providers.path.includes('..') ||
    providers.path.endsWith('/') ||
    !imagePattern.test(sourceImage)
  )
    throw new Error('Invalid Keycloak provider build recipe.')
  return `FROM ${sourceImage} AS providers
FROM ${providers.baseImage}
COPY --from=providers --chown=1000:0 ${providers.path}/*.jar /opt/keycloak/providers/
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build
`
}
const servicePattern = /^[a-z][a-z0-9-]{0,30}$/
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function parseImages(value) {
  const images = Object.create(null)
  for (const line of value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = line.indexOf('=')
    const name = line.slice(0, separator)
    const image = line.slice(separator + 1)
    if (separator < 1 || !servicePattern.test(name) || !imagePattern.test(image) || name in images)
      throw new Error('Use one unique service=image@sha256:digest entry per line.')
    images[name] = image
  }
  return images
}

export async function repositoryPath(root, value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_./-]+$/.test(value) ||
    isAbsolute(value) ||
    value.split('/').includes('..')
  )
    throw new Error('Build paths must stay inside the repository.')
  const path = await realpath(join(root, value))
  const difference = relative(await realpath(root), path)
  if (difference === '..' || difference.startsWith('../') || isAbsolute(difference))
    throw new Error('Build paths must stay inside the repository, including symlinks.')
  return path
}

export async function execute(command, args, options = {}) {
  const marker = randomUUID()
  console.log(`::stop-commands::${marker}`)
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      const consume = (data) => {
        const value = data.toString()
        output = (output + value).slice(-20000)
        if (!options.quiet) process.stdout.write(value)
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0
          ? resolve(output)
          : reject(
              Object.assign(new Error(`${command} failed with exit code ${code}.`), { output }),
            ),
      )
      child.stdin.on('error', () => {})
      child.stdin.end(options.input ?? '')
    })
  } finally {
    console.log(`::${marker}::`)
  }
}

// The registry holds the published layers. Freeing the runner lets the next service build on the same
// GitHub-hosted disk; a cleanup failure must not fail an accepted publication.
async function reclaim(exec, tag, options) {
  for (const args of [
    ['image', 'rm', '--force', tag],
    ['builder', 'prune', '--all', '--force'],
  ]) {
    try {
      await exec('docker', args, { ...options, quiet: true })
    } catch (failure) {
      console.warn(`SnapEnvs: docker ${args.join(' ')} failed and was skipped. ${failure.message}`)
    }
  }
}

export async function runAction({
  environment = process.env,
  fetchImpl = fetch,
  exec = execute,
  sleep = pause,
  now = Date.now,
} = {}) {
  const images = parseImages(environment.INPUT_IMAGES || '')
  const build = Object.keys(images).length === 0
  const wait = environment.INPUT_WAIT ?? 'true'
  const waitSeconds = Number(environment['INPUT_WAIT-SECONDS'] || 600)
  const waitInterval = Number(environment['INPUT_WAIT-INTERVAL'] || 2)
  const reclaimDisk = environment['INPUT_RECLAIM-DISK'] ?? 'true'
  if (
    !['true', 'false'].includes(wait) ||
    !Number.isInteger(waitSeconds) ||
    waitSeconds < 1 ||
    waitSeconds > 3600 ||
    !Number.isInteger(waitInterval) ||
    waitInterval < 1 ||
    waitInterval > 30
  )
    throw new Error(
      'wait must be true or false; wait-seconds must be between 1 and 3600; wait-interval must be between 1 and 30.',
    )
  if (!['true', 'false'].includes(reclaimDisk))
    throw new Error('reclaim-disk must be true or false.')
  const { projectId, secrets, exchange, request } = createClient({
    environment,
    fetchImpl,
    sleep,
    now,
    purpose: build ? 'PIPELINE' : 'DEPLOY',
  })
  let buildRequestId
  if (environment.GITHUB_EVENT_NAME === 'workflow_dispatch' && environment.GITHUB_EVENT_PATH) {
    const event = JSON.parse(await readFile(environment.GITHUB_EVENT_PATH, 'utf8'))
    buildRequestId = event.inputs?.snapenvs_request || undefined
    if (
      buildRequestId &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(buildRequestId)
    )
      throw new Error('The SnapEnvs build request ID must be a UUID.')
  }
  const plan = await request('/github/plan', buildRequestId ? { buildRequestId } : {})
  if (
    plan.commitSha !== environment.GITHUB_SHA ||
    `refs/heads/${plan.branch}` !== environment.GITHUB_REF
  )
    throw new Error('The execution plan does not match this GitHub revision.')
  const artifactPlan = Array.isArray(plan.artifacts)
  plan.services = plan.artifacts ?? plan.services
  if (
    !Array.isArray(plan.services) ||
    !plan.services.length ||
    plan.services.some((service) => !servicePattern.test(service.name)) ||
    new Set(plan.services.map((service) => service.name)).size !== plan.services.length
  )
    throw new Error('SnapEnvs returned an invalid artifact plan.')
  async function report(status, logs) {
    if (!artifactPlan && status !== 'FAILED') return
    try {
      await request(artifactPlan ? '/build-reports' : '/build-failures', {
        projectId,
        repository: plan.repository,
        branch: plan.branch,
        commitSha: plan.commitSha,
        sequence: plan.sequence,
        ...(artifactPlan ? { status } : {}),
        logs: redact(logs, secrets).slice(-20000),
      })
    } catch {
      console.warn(`SnapEnvs could not record the ${status.toLowerCase()} build report.`)
    }
  }
  if (build) {
    const dockerConfig = await mkdtemp(join(tmpdir(), 'snapenvs-docker-'))
    const childEnvironment = { ...environment, DOCKER_CONFIG: dockerConfig }
    for (const name of Object.keys(childEnvironment))
      if (name.startsWith('ACTIONS_ID_TOKEN_') || name.startsWith('INPUT_'))
        delete childEnvironment[name]
    try {
      const registry = await request('/registry')
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(registry.host) ||
        !registry.imagePrefix?.startsWith(`${registry.host}/`)
      )
        throw new Error('SnapEnvs returned an invalid registry address.')
      for (const service of plan.services) {
        for (const phase of service.keycloakProviders ? ['providers', 'runtime'] : ['image']) {
          const deriving = phase === 'runtime'
          const context = deriving
            ? join(dockerConfig, `keycloak-${service.name}`)
            : await repositoryPath(environment.GITHUB_WORKSPACE, service.context)
          const dockerfile = deriving
            ? join(context, 'Dockerfile')
            : await repositoryPath(environment.GITHUB_WORKSPACE, service.dockerfile)
          if (deriving) {
            await mkdir(context, { recursive: true })
            await writeFile(
              dockerfile,
              keycloakDockerfile(service.keycloakProviders, images[service.name]),
            )
          }
          if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79})?$/.test(service.target))
            throw new Error('Invalid Docker build target.')
          const tag = `${registry.imagePrefix}/${service.name}:run-${plan.id}`
          const options = { cwd: environment.GITHUB_WORKSPACE, env: childEnvironment }
          await exec(
            'docker',
            [
              'build',
              '--file',
              dockerfile,
              '--tag',
              tag,
              ...(!deriving && service.target ? ['--target', service.target] : []),
              ...buildArguments(deriving ? {} : service.args).flatMap(([name, value]) => [
                '--build-arg',
                `${name}=${value}`,
              ]),
              context,
            ],
            options,
          )
          // A running Docker push retains its login credentials. Restart only the push
          // after authentication failure, keeping the built image and uploaded layers.
          for (let attempt = 0; ; attempt++) {
            await exec(
              'docker',
              ['login', registry.host, '--username', registry.username, '--password-stdin'],
              { ...options, input: await exchange(attempt > 0), quiet: true },
            )
            try {
              await exec('docker', ['push', tag], options)
              break
            } catch (failure) {
              const detail = String(failure.output || failure.message || '')
              if (
                attempt >= 2 ||
                !/unauthorized: authentication required|authentication required|token has expired/i.test(
                  detail,
                )
              )
                throw failure
              await sleep(1000 * (attempt + 1))
            }
          }
          const digests = JSON.parse(
            await exec('docker', ['image', 'inspect', tag, '--format', '{{json .RepoDigests}}'], {
              ...options,
              quiet: true,
            }),
          )
          const image = digests.find(
            (value) =>
              value.startsWith(`${registry.imagePrefix}/${service.name}@`) &&
              imagePattern.test(value),
          )
          if (!image) throw new Error(`The published image digest is missing for ${service.name}.`)
          images[service.name] = image
          if (reclaimDisk === 'true') await reclaim(exec, tag, options)
        }
      }
    } catch (failure) {
      await report('FAILED', failure.output || failure.message || 'The image build failed.')
      throw new Error(redact(failure.message, secrets))
    } finally {
      await rm(dockerConfig, { recursive: true, force: true })
    }
  }
  if (
    Object.keys(images).sort().join(',') !==
    plan.services
      .map((service) => service.name)
      .sort()
      .join(',')
  )
    throw new Error(
      'Provide an image for every service and build artifact in this repository configuration.',
    )
  await report(
    'SUCCEEDED',
    build
      ? 'All configured artifacts were built and published.\n' +
          Object.entries(images)
            .map(([service, image]) => `${service}: ${image}`)
            .join('\n')
      : 'Published images supplied by the pipeline for deployment.\n' +
          Object.entries(images)
            .map(([service, image]) => `${service}: ${image}`)
            .join('\n'),
  )
  const accepted = await request('/github/releases', { runId: plan.id, images })
  let result = accepted.environment
  if (!result?.id) throw new Error('SnapEnvs returned no environment.')
  if (wait === 'true' && !accepted.deploymentSkipped) {
    const generation = accepted.deploymentGeneration
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error('SnapEnvs returned no accepted deployment generation.')
    const deadline = now() + waitSeconds * 1000
    while (result.observedState !== 'RUNNING' || result.observedGeneration < generation) {
      if (result.generation > generation)
        throw new Error('This deployment was superseded by a newer revision.')
      if (result.observedState === 'FAILED')
        throw new Error(redact(result.lastError || 'Deployment failed.', secrets))
      if (now() >= deadline)
        throw new Error('Timed out waiting for readiness. Inspect the environment in SnapEnvs.')
      await sleep(waitInterval * 1000)
      result = await request(`/environments/${result.id}`)
    }
    if (result.generation > generation)
      throw new Error('This deployment was superseded by a newer revision.')
  }
  const outputs = {
    'environment-id': result.id,
    'preview-url': result.previewUrl || '',
    'configuration-revision': String(plan.revision),
    'deployment-skipped': String(accepted.deploymentSkipped === true),
  }
  if (environment.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(outputs)) {
      const delimiter = randomUUID()
      await appendFile(environment.GITHUB_OUTPUT, `${key}<<${delimiter}\n${value}\n${delimiter}\n`)
    }
  }
  console.log(`SnapEnvs: ${result.observedState}; configuration revision ${plan.revision}.`)
  return outputs
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAction().catch((error) => {
    console.error(`SnapEnvs: ${error.message}`)
    process.exitCode = 1
  })
}
