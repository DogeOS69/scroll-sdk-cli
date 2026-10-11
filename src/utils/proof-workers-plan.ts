import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {ProofProgramPublicationV1} from '../types/proof-program-publication.js'
import type {ProofWorkerImageCheckV1} from '../types/proof-worker-image-check.js'
import type {ProofWorkersConfig} from '../types/proof-workers.js'
import type {ProverWorkerContractV1} from './proof-topology-compiler.js'

import {assertDeploymentSpecFields} from './deployment-spec-fields.js'
import {digest, localPath, privateWrite, writeJson} from './preparation-io.js'
import {resolveContractFile, validateProofDeploymentContract} from './proof-deployment-contract.js'
import {GPU_ARCHITECTURES, rentalEnvelope, rentalSeconds, resolveProofWorkers} from './proof-workers-config.js'

export interface WorkerCapacityPlan {
  config: Required<ProofWorkersConfig>
  generationId: string
  id: string
  project: string
  rentalEnvelopeUsd: number
  schema: 'scrollsdk/proof-workers/v1'
  secretName: string
  session: string
  target: {authKey: string; authSecret: string; context: string; deployment: string; image: string; namespace: string; port: number}
  tokenFile: string
  wallTimeoutSeconds: number
  workers: Array<{fleet: Record<string, unknown>; name: string; task: Record<string, unknown>}>
}

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

export function workerCommand(worker: ProverWorkerContractV1, publication: ProofProgramPublicationV1, workerId: string, architecture: string): string {
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
    `test "$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | tr -d '. ' | head -n 1)" = ${quote(architecture)}`,
    'printf %s "$DOGEOS_PROVER_WORKER_TOKEN" > /tmp/scrollsdk-worker.token', 'unset DOGEOS_PROVER_WORKER_TOKEN']
  for (const [relative, entry] of Object.entries(publication.files)) {
    if (!/^[\w./-]+$/.test(relative) || relative.split('/').includes('..') || relative.startsWith('/')) throw new Error('Unsafe publication path')
    const url = new URL(entry.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[\da-f]{64}$/.test(entry.sha256)) throw new Error('Worker artifacts require public HTTPS URLs without credentials and SHA-256 digests')
    const target = `/dogeos/artifacts/${relative}`
    commands.push(`install -d ${quote(path.posix.dirname(target))}`,
      `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --speed-limit 1024 --speed-time 30 --max-time 600 --retry 2 ${quote(entry.url)} -o ${quote(target)}`,
      `printf '%s  %s\\n' ${quote(entry.sha256)} ${quote(target)} | sha256sum --check --status`)
  }

  commands.push(`exec /usr/local/bin/prover-worker ${argv.map(value => quote(value)).join(' ')}`)
  return commands.join('; ')
}

export function capacityPlan(input: {generationId: string; imageCheck: ProofWorkerImageCheckV1; publication: ProofProgramPublicationV1; session: string; spec: DeploymentSpec; target: WorkerCapacityPlan['target']; tokenFile: string; worker: ProverWorkerContractV1}): WorkerCapacityPlan {
  const {imageCheck, publication, session, spec, worker} = input
  if (!spec.proofWorkers) throw new Error('Declare proofWorkers in the deployment spec before planning GPU capacity')
  const config = resolveProofWorkers(spec.proofWorkers)
  if (!/^[\da-z][\da-z-]{0,23}$/.test(session)) throw new Error('Session must be a lowercase name of at most 24 characters')
  const image = `${worker.image.repository}@${worker.image.digest}`
  if (!/^sha256:[\da-f]{64}$/.test(worker.image.digest) || image !== `${imageCheck.image.repository}@${imageCheck.image.digest}` || !imageCheck.cudaArchitectures.includes(GPU_ARCHITECTURES[config.gpu])) throw new Error('Selected GPU is incompatible with the checked, digest-pinned Worker image')
  if (worker.required_build_class !== 'production' || publication.verification.anonymousHttpReadback !== 'passed' || publication.verification.authenticatedS3Readback !== 'passed') throw new Error('GPU capacity requires production Worker and verified artifact publication')
  const project = spec.preparation?.dstack?.project ?? 'main'
  const seed = {config, deployment: spec.metadata.name, generationId: input.generationId, project, session, target: input.target}
  const id = digest(JSON.stringify(seed))
  const secretName = `scrollsdk_worker_${id.slice(0, 16)}`
  const resources = {cpu: `${config.cpu}..`, disk: `${config.diskGb}GB..`, gpu: {count: 1, memory: '24GB..', name: config.gpu}, memory: `${config.memoryGb}GB..`}
  const workers = Array.from({length: config.count}, (_, index) => {
    const name = `sdk-${id.slice(0, 16)}-${index}`
    const fleet = {backend_options: [{min_reliability: config.minReliability, offer_order: 'price', type: 'vastai'}], backends: ['vastai'], idle_duration: config.idleTimeoutMinutes * 60, max_price: config.maxPricePerHourUsd,
      name: `${name}-gpu`, nodes: '0..1', regions: config.regions, resources, retry: false,
      tags: {'scrollsdk-plan': id}, type: 'fleet'}
    const task = {backends: ['vastai'], commands: [workerCommand(worker, publication, `${spec.metadata.name}-${session}-${id.slice(0, 8)}-${index}`, GPU_ARCHITECTURES[config.gpu])], env: {DOGEOS_PROVER_WORKER_READY_FILE: '/dogeos/artifacts/prover-worker-ready-v1.json', DOGEOS_PROVER_WORKER_TOKEN: '${{ secrets.' + secretName + ' }}', NVIDIA_DRIVER_CAPABILITIES: 'compute,utility', SCROLLSDK_WORKER_PLAN_ID: id}, fleets: [fleet.name], idle_duration: config.idleTimeoutMinutes * 60, image, max_duration: Math.floor(config.maxDurationHours * 3600), max_price: config.maxPricePerHourUsd,
      name, nodes: 1, regions: config.regions,
      resources, retry: false, spot_policy: 'on-demand',
      stop_duration: config.stopTimeoutMinutes * 60,
      type: 'task'}
    return {fleet, name, task}
  })
  return {config, generationId: input.generationId, id, project, rentalEnvelopeUsd: rentalEnvelope(config), schema: 'scrollsdk/proof-workers/v1', secretName,
    session, target: input.target, tokenFile: input.tokenFile, wallTimeoutSeconds: rentalSeconds(config), workers}
}

export function workerControllerLocation(spec: DeploymentSpec, explicitContext?: string, currentContext: () => string = () => {
  const result = spawnSync('kubectl', ['config', 'current-context'], {encoding: 'utf8', timeout: 10_000})
  if (result.error || result.status !== 0) throw new Error('Select a Kubernetes context before planning workers, or supply --kube-context')
  return result.stdout.trim()
}): {context: string; namespace: string} {
  const context = explicitContext ?? spec.preparation?.secretUpload?.kubeContext ?? currentContext()
  if (!context.trim()) throw new Error('Worker plan requires a nonempty Kubernetes context')
  return {context, namespace: spec.dstackController?.monitoring?.namespace ?? 'dstack-system'}
}

export function createWorkerCapacityPlan(root: string, session = 'initial', specFile?: string, kubeContext?: string): WorkerCapacityPlan {
  const spec = JSON.parse(fs.readFileSync(localPath(root, '.scrollsdk/intent.json'), 'utf8')) as DeploymentSpec
  if (specFile) {
    const updated = yaml.load(fs.readFileSync(path.resolve(specFile), 'utf8')) as DeploymentSpec
    assertDeploymentSpecFields(updated)
    spec.proofWorkers = updated.proofWorkers
  }

  assertDeploymentSpecFields(spec)
  const contract = validateProofDeploymentContract(root)
  if (!contract.worker.contractFile || !contract.worker.bundleDir || !contract.inputs?.publication || contract.generation !== 'real') throw new Error('Generate and publish real Worker artifacts before planning capacity')
  const read = (f: string) => JSON.parse(fs.readFileSync(resolveContractFile(root, f), 'utf8'))
  const values = yaml.load(fs.readFileSync(localPath(root, 'values/dstack-controller-production.yaml'), 'utf8')) as {auth: {existingSecret: string; key: string}; fullnameOverride?: string; image: {digest: string; repository: string}; service?: {port?: number}}
  const location = workerControllerLocation(spec, kubeContext)
  const target = {authKey: values.auth.key, authSecret: values.auth.existingSecret, ...location,
    deployment: values.fullnameOverride ?? 'dstack-controller', image: `${values.image.repository}@${values.image.digest}`, port: values.service?.port ?? 3000}
  if (!/@sha256:[\da-f]{64}$/.test(target.image)) throw new Error('Dstack watchdog requires a digest-pinned controller image')
  const plan = capacityPlan({generationId: contract.generationId, imageCheck: read('.data/proof-worker-image-check-v1.json'), publication: read(contract.inputs.publication.path), session, spec,
    target, tokenFile: path.relative(root, path.join(resolveContractFile(root, contract.worker.bundleDir), 'prover-worker.token')), worker: read(contract.worker.contractFile)})
  const file = localPath(root, '.scrollsdk/proof-workers/plan.json')
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkerCapacityPlan
    if (previous.id !== plan.id) throw new Error('A capacity plan already exists; finish/destroy that session before planning another session with --new-session')
  }

  writeJson(file, plan)
  privateWrite(path.join(path.dirname(file), 'plan.sha256'), digest(fs.readFileSync(file)) + '\n')
  return plan
}
