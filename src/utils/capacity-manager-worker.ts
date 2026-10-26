import path from 'node:path'

import type {ProofProgramPublicationV1} from '../types/proof-program-publication.js'
import type {ProverWorkerContractV1} from './proof-topology-compiler.js'

import {digest} from './preparation-io.js'

const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`
const paths: Record<string, string> = {
  '--batch-app-config': 'batch/openvm.toml', '--batch-app-exe': 'batch/app.vmexe',
  '--bridge-app-config': 'bridge/openvm.toml', '--bridge-app-exe': 'bridge/bridge-state.vmexe',
  '--chunk-app-config': 'chunk/openvm.toml', '--chunk-app-exe': 'chunk/app.vmexe',
  '--l2-range-aggregation-app-config': 'bridge/batch-aggregation-openvm.toml',
  '--l2-range-aggregation-app-exe': 'bridge/batch-aggregation.vmexe',
  '--l2-range-aggregation-program-manifest': 'bridge/l2-range-aggregation-topology-program.json',
  '--protocol-context-json': 'protocol_context.json',
}

// Match Core's all-family renderer; additional published files remain supported.
const artifactEnvPrefixes: Record<string, string> = {
  'batch/app.vmexe': 'DOGEOS_BATCH_VMEXE',
  'batch/openvm.toml': 'DOGEOS_BATCH_CONFIG',
  'bridge/batch-aggregation.vmexe': 'DOGEOS_AGGREGATION_VMEXE',
  'bridge/batch-aggregation-openvm.toml': 'DOGEOS_AGGREGATION_CONFIG',
  'bridge/bridge-artifact-manifest.json': 'DOGEOS_BRIDGE_MANIFEST',
  'bridge/bridge-state.vmexe': 'DOGEOS_BRIDGE_VMEXE',
  'bridge/l2-range-aggregation-topology-program.json': 'DOGEOS_TAG5_MANIFEST',
  'bridge/openvm.toml': 'DOGEOS_BRIDGE_CONFIG',
  'chunk/app.vmexe': 'DOGEOS_CHUNK_VMEXE',
  'chunk/openvm.toml': 'DOGEOS_CHUNK_CONFIG',
  'protocol_context.json': 'DOGEOS_PROTOCOL_CONTEXT',
}

/** Keep the startup command and its required public environment inseparable. */
export function workerLaunch(worker: ProverWorkerContractV1, publication: ProofProgramPublicationV1, workerId: string, architecture: string | string[]): {command: string; env: Record<string, string>} {
  const architectures = [...new Set(Array.isArray(architecture) ? architecture : [architecture])]
  if (architectures.length === 0 || architectures.some(value => !/^\d{2,3}$/.test(value))) throw new Error('Invalid Worker CUDA architectures')
  const argv = [...worker.argv]
  const options = new Set(argv.filter(a => a.startsWith('--')))
  if (!options.has('--worker-id') || !options.has('--worker-token-file')) throw new Error('Compiler Worker is missing its identity/token arguments')
  const drain = Number(argv[argv.indexOf('--drain-timeout-ms') + 1])
  if (!Number.isFinite(drain) || drain > 720_000) throw new Error('Worker drain must fit the reserved 13-minute graceful stop window')
  for (let i = 0; i < argv.length; i++) {
    if (paths[argv[i]]) argv[i + 1] = `/dogeos/artifacts/${paths[argv[i]]}`
    if (argv[i] === '--worker-id') argv[i + 1] = workerId
    if (argv[i] === '--worker-token-file') argv[i + 1] = '/tmp/scrollsdk-worker.token'
  }

  for (const file of Object.values(paths)) if (!publication.files[file]) throw new Error(`Published Worker resource missing: ${file}`)
  const commands = ['set -eu', 'umask 077', 'install -d /dogeos/artifacts/chunk /dogeos/artifacts/batch /dogeos/artifacts/bridge',
    architectures.length === 1
      ? `test "$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | tr -d '. ' | head -n 1)" = ${quote(architectures[0])}`
      : `case "$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | tr -d '. ' | head -n 1)" in ${architectures.map(value => quote(value)).join('|')}) ;; *) exit 1 ;; esac`,
    'printf %s "$DOGEOS_PROVER_WORKER_TOKEN" > /tmp/scrollsdk-worker.token', 'unset DOGEOS_PROVER_WORKER_TOKEN']
  const env: Record<string, string> = {}
  for (const relative of Object.keys(publication.files).sort()) {
    const entry = publication.files[relative]
    if (!/^[\w./-]+$/.test(relative) || relative.split('/').includes('..') || relative.startsWith('/')) throw new Error('Unsafe publication path')
    const url = new URL(entry.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[\da-f]{64}$/.test(entry.sha256)) throw new Error('Worker artifacts require public HTTPS URLs without credentials and SHA-256 digests')
    // A separate namespace and full path digest avoid punctuation/case collisions
    // for extra resources without changing the known Core variable names.
    const prefix = Object.hasOwn(artifactEnvPrefixes, relative) ? artifactEnvPrefixes[relative] : `DOGEOS_ARTIFACT_${digest(relative).toUpperCase()}`
    env[`${prefix}_URL`] = entry.url
    env[`${prefix}_SHA256`] = entry.sha256
    const target = `/dogeos/artifacts/${relative}`
    commands.push(`install -d ${quote(path.posix.dirname(target))}`,
      `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --speed-limit 1024 --speed-time 30 --max-time 600 --retry 2 "$${prefix}_URL" -o ${quote(target)}`,
      `printf '%s  %s\\n' "$${prefix}_SHA256" ${quote(target)} | sha256sum --check --status`)
  }

  commands.push(`exec /usr/local/bin/prover-worker ${argv.map(value => quote(value)).join(' ')}`)
  return {command: commands.join('; '), env}
}
