/* eslint-disable @typescript-eslint/no-explicit-any -- Adapters for existing commands and deployment TOML. */
import * as toml from '@iarna/toml'
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../types/deployment-spec.js'
import type {PreparationPlan, PreparationRunner, PreparationStep} from './preparation-plan.js'

import {CONTRACTS_DOCKER_DEFAULT_TAG} from '../constants/docker.js'
import {parseDatabaseUrl} from './dstack-database.js'
import {checkPrivateKey, dogecoinRpc, prepareEthereumAnchor, prepareHelperFunding, prepareProductionBridgeFunding, prepareProductionWallets} from './preparation-funding.js'
import {AwaitingInput, localPath, privateWrite} from './preparation-io.js'
import {reuseProofAws} from './preparation-proof-aws.js'
import {importSignerReceipts} from './preparation-signer-receipts.js'
import {exportCoordinatorMaterializers} from './proof-image-tools.js'
import {readProofMaterials} from './proof-materials.js'
import {readProofSoftwareRelease} from './proof-software-release.js'
import {buildProofTopology} from './proof-topology-init.js'
import {resolveSpecProofStorage} from './spec-proof-storage.js'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')
export type Invoke = (root: string, step: string, args: string[], environment?: Record<string, string>) => Promise<void>
export const invokePreparationCommand: Invoke = async (root, step, args, environment = {}) => {
  const logs = localPath(root, '.scrollsdk/logs')
  fs.mkdirSync(logs, {mode: 0o700, recursive: true})
  const fd = fs.openSync(path.join(logs, `${step}.log`), 'a', 0o600)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'setup', ...args, '--json'], {cwd: root, env: {...process.env, ...environment}, stdio: ['ignore', fd, fd]})
      child.once('error', () => reject(new Error(`Unable to start ${step}`)))
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Step ${step} failed; inspect .scrollsdk/logs/${step}.log privately`)))
    })
  } finally {fs.closeSync(fd)}
}

function requiredFile(root: string, input: string | undefined, label: string): string {
  if (!input) throw new AwaitingInput({message: `${label} is required`})
  const file = path.resolve(root, input)
  if (!fs.existsSync(file)) throw new AwaitingInput({file, message: `Supply ${label}, then rerun apply`})
  if (!fs.statSync(file).isFile()) throw new Error(`${label} must be a regular file`)
  return file
}

const optional = (name: string, value: string | undefined): string[] => value ? [`--${name}`, value] : []

export class CommandPreparationRunner implements PreparationRunner {
  constructor(private readonly invoke: Invoke = invokePreparationCommand, private readonly exportMaterializers = exportCoordinatorMaterializers) {}
  async run(step: PreparationStep, spec: DeploymentSpec, root: string, plan: PreparationPlan): Promise<void> {
    const p = spec.preparation!
    const command = (args: string[], environment?: Record<string, string>) => this.invoke(root, step.id, args, environment)
    const bridgeArgs = ['-N', '--image', p.bridge.image, '--ethereum-da-probe', 'direct', ...(p.bridge.mode === 'production' ? ['--production'] : [])]
    switch (step.id) {
      case 'bootstrap': {
        await command(['generate-from-spec', '--spec', '.scrollsdk/intent.json', '--output', '.', '--bootstrap', '--sdk-dir', plan.sdkDirectory, '--force'])
        break
      }

      case 'identities': {
        await command(['gen-keystore', '-N']); break
      }

      case 'archive': {
        await command(['eth-da-submitter', '-N', p.archive!.action === 'create' ? '--create-archive-bucket' : '--no-create-archive-bucket', ...optional('aws-profile', p.archive!.awsProfile), ...optional('role-arn', p.archive!.writerRoleArn)]); break
      }

      case 'proof-aws': {
        if (p.proofAws!.action === 'reuse') {reuseProofAws(root, spec); break}
        await command(['proof-aws-init', '-N', '--yes', '--aws-region', spec.infrastructure.aws!.region, '--eks-cluster', spec.infrastructure.aws!.eksClusterName!, '--namespace', spec.infrastructure.namespace ?? 'default', '--deployment-alias', spec.metadata.name, '--artifact-public-read-mode', p.proofAws!.publicReadMode, ...optional('artifact-public-endpoint-url', p.proofAws!.publicEndpointUrl), ...optional('aws-profile', p.proofAws!.awsProfile), ...optional('secret-name', p.proofAws!.secretName), ...optional('coordinator-service-account', spec.proofCoordinator?.serviceAccount?.name), ...optional('withdrawal-service-account', spec.proofCoordinator?.withdrawalProcessorServiceAccount?.name)]); break
      }

      case 'dstack': {
        const d = p.dstack
        if (d?.databaseUrlEnv) {
          const url = process.env[d.databaseUrlEnv]
          if (!url) throw new AwaitingInput({message: `Set ${d.databaseUrlEnv} to the existing dstack database URL`})
          const parsed = parseDatabaseUrl(url)
          if (parsed.protocol !== 'postgresql+asyncpg:' || parsed.searchParams.has('sslmode')) throw new Error('Dstack database URL requires postgresql+asyncpg and ssl, not sslmode')
          const file = path.join(root, 'config.toml')
          const config = toml.parse(fs.readFileSync(file, 'utf8')) as any
          config.db ??= {}; config.db.DSTACK_DB_CONNECTION_STRING = `$ENV:${d.databaseUrlEnv}`
          privateWrite(file, toml.stringify(config))
        }

        if (d?.mode === 'external') break
        const args = ['dstack-config', '-N', ...(d?.providers ?? []).flatMap(provider => ['--provider', provider]), ...optional('project', d?.project), ...optional('gcp-project-id', d?.gcpProjectId)]
        if (d?.vastaiApiKeyEnv) {
          if (!process.env[d.vastaiApiKeyEnv]?.trim()) throw new AwaitingInput({message: `Set ${d.vastaiApiKeyEnv} to the Vast.ai API key, then rerun apply`})
          args.push('--vastai-api-key-env', d.vastaiApiKeyEnv)
        }

        if (d?.vastaiApiKeyFile) args.push('--vastai-api-key-file', requiredFile(root, d.vastaiApiKeyFile, 'Vast.ai key file'))
        if (d?.gcpServiceAccountFile) args.push('--gcp-service-account', requiredFile(root, d.gcpServiceAccountFile, 'GCP service account file'))
        await command(args); break
      }

      case 'dstack-db': case 'blockscout-db': {
        await command(['db-init', '-N', '--databases', step.id === 'dstack-db' ? 'dstack' : 'blockscout']); break
      }

      case 'descriptors': {
        const args = p.attestationDescriptors.flatMap(file => ['--descriptor', requiredFile(root, file, 'partner descriptor')])
        await command(['attestation-signer', ...args]); break
      }

      case 'genesis': {
        await command(['gen-l2-artifacts', '-N', '--skip-deployment-salt-update', ...(p.genesis?.contractsSource ? ['--contracts-source', path.resolve(root, p.genesis.contractsSource)] : ['--image-tag', CONTRACTS_DOCKER_DEFAULT_TAG])]); break
      }

      case 'bridge-prepare': {
        await command(['bridge-init', '--step', '1-prepare', ...bridgeArgs, ...(p.bridge.mode === 'helper' ? ['--seed-env', 'SCROLLSDK_PREPARATION_HELPER_SEED'] : [])], p.bridge.mode === 'helper' ? {SCROLLSDK_PREPARATION_HELPER_SEED: spec.bridge.seedString!} : undefined); break
      }

      case 'ethereum-anchor': {await prepareEthereumAnchor(root, spec); break}
      case 'production-wallets': {await prepareProductionWallets(root, spec, dogecoinRpc(root)); break}
      case 'production-funding': {await prepareProductionBridgeFunding(root, spec, dogecoinRpc(root)); break}
      case 'helper-funding': {await prepareHelperFunding(root, spec, dogecoinRpc(root)); break}
      case 'helper-setup': {await command(['bridge-init', '--step', '2-setup', ...bridgeArgs]); break}
      case 'helper-fund': {await command(['bridge-init', '--step', '4-fund', ...bridgeArgs]); break}
      case 'bridge-info': {await command(['bridge-init', '--step', '3-bridge-info', ...bridgeArgs]); break}
      case 'protocol-context': {await command(['bridge-init', '--step', '5-protocol-context', ...bridgeArgs]); break}
      case 'external-inputs': {
        for (const item of p.inputs ?? []) {
          const source = requiredFile(root, item.source, 'external runtime input')
          privateWrite(localPath(root, item.destination), fs.readFileSync(source))
        }

        break
      }

      case 'proof-release-bake': {
        const release = p.proofRelease!
        await command(['proof-image-tools', '--action', 'prepare-real', '--release', requiredFile(root, release.manifest, 'approved proof release manifest'), '--release-sha256', release.sha256!, '--protocol-context', '.data/protocol_context.json', '--output', '.data/proof-release-preparation']); break
      }

      case 'proof-materializer-export': {
        const release = p.proofRelease!
        const selected = readProofSoftwareRelease(requiredFile(root, release.manifest, 'approved proof release manifest'), release.sha256!)
        this.exportMaterializers({expectedRevision: selected.manifest.revision, image: selected.manifest.images['proof-coordinator'], outputDir: localPath(root, '.data/proof-release-materializers')}); break
      }

      case 'proof-worker-check': {
        const release = p.proofRelease!
        const selected = readProofSoftwareRelease(requiredFile(root, release.manifest, 'approved proof release manifest'), release.sha256!)
        await command(['proof-worker-image-check', '--image', selected.manifest.images['prover-worker-cuda'], '--preparation-receipt', '.data/proof-release-preparation/proof-release-preparation-v1.json', '--output', '.data/proof-worker-image-check-v1.json']); break
      }

      case 'proof-materials': {
        const m = p.proofRelease ? {...p.proofMaterials,
          batchMaterializer: '.data/proof-release-materializers/scroll-runtime-materializer',
          chunkMaterializer: '.data/proof-release-materializers/materialize-chunk-oneshot',
          preparationReceipt: '.data/proof-release-preparation/proof-release-preparation-v1.json',
          productionWorkerReceipt: '.data/proof-worker-image-check-v1.json',
        } : p.proofMaterials
        const receipt = m.receipt ?? '.data/proof-materials-v1.json'
        localPath(root, receipt)
        if (m.mode === 'existing' && !m.receipt) {
          requiredFile(root, spec.proofTopology!.compiler.identityFilePath, 'compiler identity input')
          break
        }

        if (m.mode !== 'existing') {
          const compiler = spec.proofTopology!.compiler.image
          const args = ['proof-materials', '-N', '--generation', m.mode, '--compiler-image', `${compiler.repository}@${compiler.digest}`, '--output', receipt, ...optional('mock-worker-image', m.mockWorkerImage)]
          for (const [name, value] of [['preparation-receipt', m.preparationReceipt], ['production-worker-receipt', m.productionWorkerReceipt], ['chunk-materializer', m.chunkMaterializer], ['batch-materializer', m.batchMaterializer]] as const) if (value) args.push(`--${name}`, requiredFile(root, value, name))
          await command(args)
        }

        const materials = readProofMaterials(requiredFile(root, receipt, 'proof materials receipt'), root)
        const previous = resolveSpecProofStorage(spec).proofTopology!
        const topology = buildProofTopology({artifactStore: previous.active!.artifactStore, deploymentName: spec.metadata.name, enforcement: previous.enforcement, generation: previous.generation, materials, mode: previous.mode, runtime: {
          artifactKeyPrefix: previous.deployment.artifactKeyPrefix, blockWitnessDir: previous.active!.realScroll.chunkBlockWitnessDir, observeRealProofDeadlineMs: previous.observeRealProofDeadlineMs,
          proofCoordinatorPublicUrl: previous.deployment.proverPublicUrl!, publicS3EndpointUrl: previous.deployment.publicS3EndpointUrl,
          rpcWitnessUrl: previous.active!.realScroll.chunkWitnessRpcUrl, witnessSource: previous.active!.realScroll.chunkWitnessSource, workerDeploymentBackend: previous.deployment.workerDeploymentBackend,
          workerLaunch: previous.active!.workerLaunch, workerNodeSelector: previous.deployment.workerNodeSelector, workerResources: previous.deployment.workerResources, workerRuntimeClassName: previous.deployment.workerRuntimeClassName, workerSecretName: previous.deployment.workerSecretName, workerTolerations: previous.deployment.workerTolerations,
        }})
        const file = path.join(root, '.data/doge-config.toml')
        const config = toml.parse(fs.readFileSync(file, 'utf8')) as any
        config.proof_topology = topology
        privateWrite(file, toml.stringify(config))
        break
      }

      case 'charts': case 'charts-published': case 'charts-validated': {
        const args = ['prep-charts', '-N', '--skip-auth-check', '--skip-l2-contract-deployment-block']
        const receipt = p.proofMaterials.receipt ?? '.data/proof-materials-v1.json'
        if (fs.existsSync(path.resolve(root, receipt))) args.push('--proof-materials-receipt', receipt)
        if (p.proofPublication && step.id !== 'charts') args.push('--proof-publication-receipt', '.data/proof-program-publication-v1.json')
        await command(args); break
      }

      case 'proof-publish': {
        const publication = p.proofPublication!
        await command(['proof-bundle-publish', '--apply', '--release', requiredFile(root, publication.release ?? p.proofRelease?.manifest, 'proof release manifest'), '--release-sha256', (publication.releaseSha256 ?? p.proofRelease?.sha256)!, '--materials', p.proofMaterials.receipt ?? '.data/proof-materials-v1.json', ...optional('aws-profile', publication.awsProfile)]); break
      }

      case 'secrets': {
        const policy = p.bridge.production
        if (p.bridge.mode === 'production' && policy) {
          checkPrivateKey(policy.sequencerPublicKey, policy.sequencerKeyEnv)
          checkPrivateKey(policy.feeWalletPublicKey, policy.feeWalletKeyEnv)
        }

        await command(['gen-secrets', '-N']); break
      }

      case 'signer-policy': {await command(['export-signer-policy']); break}
      case 'signer-receipts': {await importSignerReceipts(root); break}
      case 'proof-check': {await command(['proof-config-check']); break}
      case 'secret-upload': {
        const upload = p.secretUpload!
        await command(['push-secrets', '-N', '--provider', upload.provider, ...optional('aws-region', upload.awsRegion ?? spec.infrastructure.aws?.region), ...optional('aws-prefix', upload.awsPrefix), ...optional('kube-context', upload.kubeContext), ...optional('namespace', upload.namespace ?? spec.infrastructure.namespace ?? 'default')]); break
      }

      default: {throw new Error(`Unsupported preparation step: ${step.id}`)}
    }
  }
}
