import { appendFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createClient, redact } from './client.mjs'
export { apiOrigin } from './client.mjs'

const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]{0,220}@sha256:[a-f0-9]{64}$/
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
  const { projectId, secrets, exchange, request } = createClient({
    environment,
    fetchImpl,
    sleep,
    now,
    purpose: build ? 'PIPELINE' : 'DEPLOY',
  })
  const plan = await request('/github/plan', {})
  if (
    plan.commitSha !== environment.GITHUB_SHA ||
    `refs/heads/${plan.branch}` !== environment.GITHUB_REF
  )
    throw new Error('The execution plan does not match this GitHub revision.')
  if (
    !Array.isArray(plan.services) ||
    !plan.services.length ||
    plan.services.some((service) => !servicePattern.test(service.name))
  )
    throw new Error('SnapEnvs returned an invalid service plan.')
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
        const context = await repositoryPath(environment.GITHUB_WORKSPACE, service.context)
        const dockerfile = await repositoryPath(environment.GITHUB_WORKSPACE, service.dockerfile)
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
            ...(service.target ? ['--target', service.target] : []),
            context,
          ],
          options,
        )
        // Builds can outlive OIDC credentials. Authenticate immediately before publishing.
        await exec(
          'docker',
          ['login', registry.host, '--username', registry.username, '--password-stdin'],
          { ...options, input: await exchange(), quiet: true },
        )
        await exec('docker', ['push', tag], options)
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
      }
    } catch (failure) {
      try {
        await request('/build-failures', {
          projectId,
          repository: plan.repository,
          branch: plan.branch,
          commitSha: plan.commitSha,
          sequence: plan.sequence,
          logs: redact(failure.output || failure.message, secrets).slice(-20000),
        })
      } catch {
        console.warn('SnapEnvs could not record the build failure.')
      }
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
    throw new Error('Provide an image for every service in this repository configuration.')
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
