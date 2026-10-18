import { appendFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createClient, redact } from '../client.mjs'

async function writeValue(file, key, value) {
  const delimiter = randomUUID()
  await appendFile(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`)
}

export async function registryAuth({
  environment = process.env,
  fetchImpl = fetch,
  now = Date.now,
  sleep,
} = {}) {
  for (const key of ['GITHUB_ENV', 'GITHUB_STATE', 'GITHUB_OUTPUT']) {
    if (!environment[key]) throw new Error(`GitHub Actions must provide ${key}.`)
  }
  const client = createClient({ environment, fetchImpl, now, sleep, purpose: 'IMAGE_PUBLISH' })
  let directory
  try {
    const registry = await client.request('/registry')
    if (
      typeof registry.host !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(registry.host) ||
      typeof registry.imagePrefix !== 'string' ||
      !registry.imagePrefix.startsWith(`${registry.host}/`) ||
      !/^[a-zA-Z0-9./:_-]+$/.test(registry.imagePrefix) ||
      typeof registry.username !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(registry.username)
    )
      throw new Error('SnapEnvs returned invalid registry metadata.')

    const token = await client.exchange()
    const auth = Buffer.from(`${registry.username}:${token}`).toString('base64')
    console.log(`::add-mask::${auth}`)
    directory = await mkdtemp(join(tmpdir(), 'snapenvs-registry-'))
    // Save cleanup state before creating a credential file or exporting its location.
    await writeValue(environment.GITHUB_STATE, 'snapenvsDockerConfig', directory)
    await writeValue(
      environment.GITHUB_STATE,
      'previousDockerConfig',
      environment.DOCKER_CONFIG || '',
    )
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ auths: { [registry.host]: { auth } } }),
      { mode: 0o600 },
    )
    await writeValue(environment.GITHUB_ENV, 'DOCKER_CONFIG', directory)
    const outputs = {
      host: registry.host,
      'image-prefix': registry.imagePrefix,
      username: registry.username,
      'expires-at': client.expiresAt(),
    }
    for (const [key, value] of Object.entries(outputs))
      await writeValue(environment.GITHUB_OUTPUT, key, value)
    console.log('SnapEnvs registry authentication is ready for subsequent Docker or crane steps.')
    return outputs
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true })
    throw new Error(redact(error.message, client.secrets))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  registryAuth().catch((error) => {
    console.error(`SnapEnvs: ${error.message}`)
    process.exitCode = 1
  })
}
