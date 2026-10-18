import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('cached runtime publisher passes its Python regression suite', async () => {
  await promisify(execFile)('python3', [
    fileURLToPath(new URL('./github-publish-image_test.py', import.meta.url)),
    '-v',
  ])
})
