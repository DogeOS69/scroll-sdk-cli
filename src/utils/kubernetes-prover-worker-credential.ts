import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'

import type {ProofDeploymentContract} from './proof-deployment-contract.js'
import type {ProverWorkerContractV1} from './proof-topology-compiler.js'

import {resolveContractFile} from './proof-deployment-contract.js'
import {WORKER_CREDENTIAL_SECRET_KEY} from './proof-topology-kubernetes-adapter.js'
import {validateWorkerName, workerCredentialName} from './prover-worker-credential.js'

export interface KubernetesWorkerCredentialTarget {
  context: string
  namespace: string
  secretName: string
  workerId: string
}

/** Call only after validateProofDeploymentContract has checked the generated files. */
export function kubernetesWorkerCredentialTarget(
  deploymentDir: string,
  contract: ProofDeploymentContract,
  context?: string,
  namespace?: string,
): KubernetesWorkerCredentialTarget {
  if (!context?.trim() || !namespace?.trim()) throw new Error('Kubernetes workers require explicit --kube-context and --namespace')
  if (contract.worker.kind !== 'compiled-local' || !contract.worker.enabled || !contract.components.proverWorker.enabled || !contract.worker.contractFile) {
    throw new Error('setup proof-worker requires an enabled compiled-local Kubernetes worker')
  }

  const worker = JSON.parse(fs.readFileSync(resolveContractFile(deploymentDir, contract.worker.contractFile), 'utf8')) as ProverWorkerContractV1
  const index = worker.argv.indexOf('--worker-id')
  if (index < 0 || !worker.argv[index + 1]) throw new Error('compiled worker has no worker id')
  const workerId = worker.argv[index + 1]
  validateWorkerName(workerId)
  const values = yaml.load(fs.readFileSync(resolveContractFile(deploymentDir, contract.components.proverWorker.valuesFile), 'utf8')) as {
    persistence?: Record<string, {items?: Array<{key: string; path: string}>; name?: string; type?: string}>
  }
  const volume = values.persistence?.['prover-worker-token']
  if (volume?.type !== 'secret' || !volume.name || volume.items?.length !== 1 || volume.items[0].key !== WORKER_CREDENTIAL_SECRET_KEY) {
    throw new Error('worker must mount only its credential key from a dedicated Secret; rerun prep-charts')
  }

  const coordinatorValues = yaml.load(fs.readFileSync(resolveContractFile(deploymentDir, contract.components.proofCoordinator.valuesFile), 'utf8')) as {
    persistence?: Record<string, {name?: string; type?: string}>
  }
  if (Object.values(coordinatorValues.persistence ?? {}).some(item => item.type === 'secret' && item.name === volume.name)) {
    throw new Error('worker credential requires a dedicated Secret, separate from coordinator Secrets; rerun prep-charts')
  }

  return {context, namespace, secretName: volume.name, workerId}
}

export function provisionKubernetesWorkerCredential(target: KubernetesWorkerCredentialTarget, credential: string): void {
  if (workerCredentialName(credential) !== target.workerId) throw new Error('worker credential does not match the compiled worker id')
  const secret = {
    apiVersion: 'v1',
    data: {[WORKER_CREDENTIAL_SECRET_KEY]: Buffer.from(credential).toString('base64')},
    kind: 'Secret',
    metadata: {name: target.secretName, namespace: target.namespace},
    type: 'Opaque',
  }
  // No credential in argv, local files, last-applied annotation, or error output.
  const result = spawnSync('kubectl', [
    '--context', target.context, '--namespace', target.namespace,
    'apply', '--server-side', '--field-manager=scrollsdk-worker-credential', '-f', '-',
  ], {encoding: 'utf8', input: JSON.stringify(secret), timeout: 30_000})
  if (result.error || result.status !== 0) throw new Error('Failed to provision Kubernetes worker credential; check cluster access and Secret field ownership')
}
