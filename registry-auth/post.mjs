import { appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export async function cleanup({ environment = process.env } = {}) {
  const directory = environment.STATE_snapenvsDockerConfig
  if (!directory) return
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !/^snapenvs-registry-[a-zA-Z0-9]+$/.test(basename(directory))
  ) {
    throw new Error(
      'Refusing to remove a directory outside the SnapEnvs registry credential scope.',
    )
  }
  await rm(directory, { recursive: true, force: true })
  if (environment.GITHUB_ENV && environment.DOCKER_CONFIG === directory) {
    const delimiter = randomUUID()
    await appendFile(
      environment.GITHUB_ENV,
      `DOCKER_CONFIG<<${delimiter}\n${environment.STATE_previousDockerConfig || ''}\n${delimiter}\n`,
    )
  }
  console.log('SnapEnvs temporary registry credentials removed.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanup().catch((error) => {
    console.error(`SnapEnvs: ${error.message}`)
    process.exitCode = 1
  })
}
