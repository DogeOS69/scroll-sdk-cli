import {spawnSync} from 'node:child_process'

export function capacityExec(args: string[], input?: string): string {
  const result = spawnSync('kubectl', args, {encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024, timeout: 180_000})
  // kubectl/API errors can contain command stdin, environment or provider secrets.
  if (result.error || result.status !== 0) throw new Error('Capacity Manager Kubernetes operation failed; check capacity-manager status before retrying (remote details omitted)')
  return result.stdout
}
