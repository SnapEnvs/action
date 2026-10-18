export function apiOrigin(value) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Use an HTTPS API origin, without a path or credentials.')
  return url.origin
}

export function redact(value, secrets) {
  let result = String(value)
  for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]')
  return result
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

export function createClient({
  environment = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  purpose,
}) {
  const base = apiOrigin(environment['INPUT_API-URL'] || 'https://snapenvs.com')
  const projectId = environment.INPUT_PROJECT
  if (!/^[a-f0-9-]{36}$/i.test(projectId ?? ''))
    throw new Error('Set project to the SnapEnvs project UUID.')
  if (
    !['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME) ||
    !environment.GITHUB_REF?.startsWith('refs/heads/')
  )
    throw new Error('Run this action on a trusted branch using push or workflow_dispatch.')
  const secrets = [environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN]
  let credential
  async function exchange(force = false) {
    if (!force && credential && Date.parse(credential.expiresAt) > now() + 60000)
      return credential.token
    const url = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL || 'https://invalid')
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.actions.githubusercontent.com') ||
      url.username ||
      url.password
    )
      throw new Error('A GitHub OIDC request URL is required. Grant id-token: write to this job.')
    url.searchParams.set('audience', 'https://snapenvs.com')
    const identityResponse = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    if (!identityResponse.ok)
      throw new Error('GitHub could not issue an OIDC identity. Grant id-token: write.')
    const identity = (await identityResponse.json()).value
    if (typeof identity !== 'string' || !identity)
      throw new Error('GitHub returned no OIDC identity.')
    secrets.push(identity)
    const response = await fetchImpl(`${base}/api/v1/ci/token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        projectId,
        provider: 'GITHUB',
        idToken: identity,
        purpose,
      }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok)
      throw new Error(
        redact(body.detail || `Identity exchange failed (${response.status}).`, secrets),
      )
    if (
      typeof body.token !== 'string' ||
      !Number.isFinite(Date.parse(body.expiresAt)) ||
      Date.parse(body.expiresAt) <= now()
    )
      throw new Error('SnapEnvs returned an invalid or expired credential.')
    credential = body
    secrets.push(body.token)
    console.log(`::add-mask::${body.token.replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`)
    return body.token
  }
  async function request(path, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await exchange()
      let response
      try {
        response = await fetchImpl(`${base}/api/v1/ci${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        })
      } catch (error) {
        if (attempt === 2) throw new Error(redact(error.message, secrets))
        await sleep((attempt + 1) * 1000)
        continue
      }
      const result = await response.json().catch(() => ({}))
      if (response.ok) return result
      if (response.status === 401 && attempt < 2) {
        await exchange(true)
        continue
      }
      if (response.status >= 500 && attempt < 2) {
        await sleep((attempt + 1) * 1000)
        continue
      }
      throw new Error(
        redact(result.detail || `SnapEnvs returned HTTP ${response.status}.`, secrets),
      )
    }
  }
  return { projectId, secrets, exchange, request, expiresAt: () => credential?.expiresAt }
}
