import Docker from 'dockerode'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import toml from 'toml'

import {PREINSTALLS_CHECK_IMAGE} from './preinstalls-image-check.js'

export interface PreinstallsVerificationPlan {
  apiUrl: string
  image: string
}

export class PreinstallsVerificationExitError extends Error {
  constructor(public readonly exitCode: number) {
    super(`Preinstalls source verification exited with status code ${exitCode}.`)
  }
}

/** The released image implements Blockscout v2, not Forge's Etherscan API. */
export function preparePreinstallsVerification(directory: string, image = PREINSTALLS_CHECK_IMAGE): PreinstallsVerificationPlan {
  let config
  try {
    config = toml.parse(readFileSync(path.join(directory, 'config.toml'), 'utf8'))
  } catch {
    // TOML parser diagnostics can include lines containing operator secrets.
    throw new Error('Cannot read or parse config.toml in --config-dir for preinstalls verification.')
  }

  const verification = config.contracts?.verification
  if (verification?.VERIFIER_TYPE_L2 !== 'blockscout') {
    throw new Error('Preinstalls source verification requires contracts.verification.VERIFIER_TYPE_L2 = "blockscout" and a Blockscout v2 API. Etherscan-compatible APIs (including l2scan) are not supported by the released preinstalls image.')
  }

  if (verification.EXPLORER_API_KEY_L2) {
    throw new Error('The preinstalls Blockscout v2 verifier does not support EXPLORER_API_KEY_L2. Use an unauthenticated Blockscout v2 endpoint; the API key will not be forwarded.')
  }

  let url: URL
  try {
    if (typeof verification.EXPLORER_URI_L2 !== 'string') throw new Error('missing URL')
    url = new URL(verification.EXPLORER_URI_L2)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('unsupported URL')
  } catch {
    throw new Error('contracts.verification.EXPLORER_URI_L2 must be an HTTP(S) Blockscout site or /api URL without credentials, query parameters, or a fragment.')
  }

  const pathname = url.pathname.replace(/\/+$/, '')
  if (/\/api\/v2(?:\/|$)/.test(pathname)) {
    throw new Error('EXPLORER_URI_L2 must be the Blockscout site or /api root, not an /api/v2 endpoint.')
  }

  url.pathname = pathname.endsWith('/api') ? pathname : `${pathname}/api`
  if (!image.trim() || image !== image.trim() || /\s/.test(image)) throw new Error('--preinstalls-image must be a Docker image reference without whitespace.')
  return {apiUrl: url.toString(), image}
}

/** Override deploy.sh explicitly. No deployment directory or signing keys enter this container. */
export async function runPreinstallsVerification(plan: PreinstallsVerificationPlan, log: (message: string) => void): Promise<void> {
  const docker = new Docker()
  const pullStream = await docker.pull(plan.image)
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(pullStream, error => error ? reject(new Error('Could not pull the preinstalls verification image.')) : resolve())
  })

  const container = await docker.createContainer({
    Cmd: [plan.apiUrl],
    Entrypoint: ['bash', '/app/lib/verify-blockscout.sh'],
    HostConfig: {NetworkMode: 'host'},
    Image: plan.image,
    // Merge output without Docker's multiplex framing; no stdin is attached.
    Tty: true,
  })
  try {
    await container.start()
    const result = await container.wait()
    const output = await container.logs({follow: false, stderr: true, stdout: true})
    log(output.toString().replaceAll(plan.apiUrl, '[Blockscout API]'))
    if (result.StatusCode !== 0) throw new PreinstallsVerificationExitError(result.StatusCode)
    log('Preinstalls verification submissions accepted (or already verified). Check Blockscout for final verification results.')
  } finally {
    await container.remove({force: true})
  }
}
