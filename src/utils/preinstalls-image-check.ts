import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

// Keep aligned with scroll-sdk/examples/values/preinstalls-production.yaml.
export const PREINSTALLS_CHECK_IMAGE = 'dogeos69/preinstalls:v0.2.2'

/** verify.sh and cast may echo RPC credentials in normal output or diagnostics. */
function redactRpc(output: string, rpcUrl: string): string {
  const values = new Set([rpcUrl, rpcUrl.replace(/^https?:\/\//, '')])
  try {
    const url = new URL(rpcUrl)
    values.add(url.host)
    for (const value of [url.username, url.password, url.pathname === '/' ? '' : url.pathname, ...url.searchParams.values()]) {
      if (value) {
        values.add(value)
        values.add(decodeURIComponent(value))
      }
    }
  } catch { /* The caller validates the RPC; still redact the full value. */ }

  let result = output.replaceAll(/^RPC:.*$/gm, 'RPC: [redacted]')
  for (const value of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(value, '[redacted]')
  }

  return result
}

/** Run only the read-only verifier, overriding the image's deployment entrypoint. */
export async function checkPreinstallsImage(image: string, rpcUrl: string): Promise<{exitCode: null | number; output: string}> {
  const args = [
    'run', '--rm', '--network', 'host', '--entrypoint', 'bash',
    '--env', 'SCROLLSDK_CHECK_RPC_URL', image,
    '-c', 'exec bash /app/lib/verify.sh "$SCROLLSDK_CHECK_RPC_URL"',
  ]
  try {
    const {stderr, stdout} = await execFileAsync('docker', args, {
      env: {...process.env, SCROLLSDK_CHECK_RPC_URL: rpcUrl},
      maxBuffer: 4 * 1024 * 1024,
    })
    return {exitCode: 0, output: redactRpc(stdout + stderr, rpcUrl)}
  } catch (error) {
    const failure = error as {code?: number | string; stderr?: string; stdout?: string}
    const output = (failure.stdout ?? '') + (failure.stderr ?? '')
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      output: redactRpc(output || 'Unable to run the preinstalls verifier. Check that Docker is installed and available.', rpcUrl),
    }
  }
}
