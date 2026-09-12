import {spawnSync} from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {ProofMaterialsV1} from '../types/proof-materials.js'
import type {ProofProgramPublicationV1} from '../types/proof-program-publication.js'
import type {ValidatedProofTopologyBundle} from './proof-topology-compiler.js'

import {PROOF_PROGRAM_PUBLICATION_SCHEMA} from '../types/proof-program-publication.js'
import {readProofAwsConfig} from './proof-aws-config.js'
import {proofArtifactS3Endpoint} from './proof-aws-provisioner.js'
import {immutableProofImage, readProofMaterials} from './proof-materials.js'
import {validateProofTopologyBundle} from './proof-topology-compiler.js'

export const DEFAULT_PROOF_PROGRAM_PUBLICATION_RECEIPT = '.data/proof-program-publication-v1.json'

interface BundleFile {
  prefix: string
  relativePath: string
  sha256: string
  sizeBytes: number
  source: string
}

export interface ProofProgramPublicationPlan {
  artifactStore: ProofProgramPublicationV1['artifactStore']
  bundleId: string
  coreRevision: string
  files: BundleFile[]
  proofTopologyBundleRevision: string
  publicEndpointUrl: string
  publisherScript: string
  uploadEndpointUrl: string
}

export type ProofProgramCommandRunner = (
  command: string,
  args: string[],
  options?: {env?: NodeJS.ProcessEnv},
) => string

export type AnonymousObjectReader = (url: string) => Promise<{sha256: string; sizeBytes: number}>

export interface PlanProofProgramPublicationOptions {
  coreDir: string
  deploymentDir: string
  materialsReceipt: string
  proofAwsConfig: string
  run?: ProofProgramCommandRunner
  topologyBundle: string
}

export interface PublishProofProgramOptions extends PlanProofProgramPublicationOptions {
  anonymousRead?: AnonymousObjectReader
  awsProfile?: string
  output: string
}

const EXPECTED_BUNDLE_PATHS = new Set([
  'batch/app.vmexe',
  'batch/openvm.toml',
  'bridge/batch-aggregation-openvm.toml',
  'bridge/batch-aggregation.vmexe',
  'bridge/bridge-artifact-manifest.json',
  'bridge/bridge-state.vmexe',
  'bridge/l2-range-aggregation-topology-program.json',
  'bridge/openvm.toml',
  'chunk/app.vmexe',
  'chunk/openvm.toml',
  'protocol_context.json',
])

function command(command: string, args: string[], options: {env?: NodeJS.ProcessEnv} = {}): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 1_800_000,
  })
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function regularFile(file: string, label: string): string {
  const resolved = path.resolve(file)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(resolved)
  } catch {
    throw new Error(`${label} does not exist: ${resolved}`)
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`${label} must be a nonempty regular, non-symlink file: ${resolved}`)
  }

  return resolved
}

function publisherContract(script: string): Array<{prefix: string; relativePath: string}> {
  const body = fs.readFileSync(regularFile(script, 'dogeos-core real-proof publisher'), 'utf8')
  const found = [...body.matchAll(/^\s*"(DOGEOS_[\dA-Z_]+):([^\n\r"]+)"\s*$/gm)]
    .map(match => ({prefix: match[1], relativePath: match[2]}))
  if (found.length !== 11 || new Set(found.map(item => item.prefix)).size !== 11
    || new Set(found.map(item => item.relativePath)).size !== 11) {
    throw new Error('dogeos-core publisher must expose exactly 11 unique BUNDLE_FILES entries')
  }

  const paths = new Set(found.map(item => item.relativePath))
  if ([...EXPECTED_BUNDLE_PATHS].some(item => !paths.has(item)) || [...paths].some(item => !EXPECTED_BUNDLE_PATHS.has(item))) {
    throw new Error('dogeos-core publisher bundle contract changed; update scrollsdk before publishing')
  }

  return found
}

function materialPath(deploymentDir: string, file: {path: string}, label: string): string {
  return regularFile(path.resolve(deploymentDir, file.path), label)
}

function sourceMap(
  deploymentDir: string,
  materials: ProofMaterialsV1,
  topology: ValidatedProofTopologyBundle,
): Map<string, string> {
  const software = materials.software.artifacts
  const {bridge} = materials
  if (!software || !bridge?.artifacts.workerIdentityBundle || !materials.images.productionWorker) {
    throw new Error('Program publication requires complete real proof materials, Bridge bake, and a production Worker image')
  }

  if (!topology.manifest.generated_materials) throw new Error('Real topology bundle does not contain compiler-generated materials')
  const tag5 = regularFile(
    path.join(topology.bundleDir, topology.manifest.generated_materials, 'program-manifests/l2-range-aggregation-topology-program.json'),
    'Compiler-generated tag-5 program manifest',
  )
  const protocol = regularFile(path.resolve(deploymentDir, bridge.protocolContextPath), 'Deployment protocol context')
  if (sha256(protocol) !== bridge.protocolContextSha256) throw new Error('Deployment protocol context changed after Bridge bake')
  return new Map([
    ['batch/app.vmexe', materialPath(deploymentDir, software.batchAppExe, 'Batch vmexe')],
    ['batch/openvm.toml', materialPath(deploymentDir, software.batchAppConfig, 'Batch OpenVM config')],
    ['bridge/batch-aggregation.vmexe', materialPath(deploymentDir, bridge.artifacts.l2RangeAppExe, 'L2-range vmexe')],
    ['bridge/batch-aggregation-openvm.toml', materialPath(deploymentDir, bridge.artifacts.l2RangeAppConfig, 'L2-range OpenVM config')],
    ['bridge/bridge-artifact-manifest.json', materialPath(deploymentDir, bridge.artifacts.nativeManifest, 'Bridge manifest')],
    ['bridge/bridge-state.vmexe', materialPath(deploymentDir, bridge.artifacts.appExe, 'Bridge vmexe')],
    ['bridge/l2-range-aggregation-topology-program.json', tag5],
    ['bridge/openvm.toml', materialPath(deploymentDir, bridge.artifacts.appConfig, 'Bridge OpenVM config')],
    ['chunk/app.vmexe', materialPath(deploymentDir, software.chunkAppExe, 'Chunk vmexe')],
    ['chunk/openvm.toml', materialPath(deploymentDir, software.chunkAppConfig, 'Chunk OpenVM config')],
    ['protocol_context.json', protocol],
  ])
}

function bundleId(files: BundleFile[]): string {
  const hash = crypto.createHash('sha256')
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(`${file.relativePath}\0${file.sha256}\0${file.sizeBytes}\n`)
  }

  return hash.digest('hex')
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}

function checkCoreRevision(coreDir: string, expected: string, run: ProofProgramCommandRunner): void {
  const actual = run('git', ['-C', coreDir, 'rev-parse', 'HEAD']).trim()
  if (actual !== expected) throw new Error(`dogeos-core checkout revision ${actual} does not match materials revision ${expected}`)
  const dirty = run('git', ['-C', coreDir, 'status', '--porcelain', '--untracked-files=no']).trim()
  if (dirty) throw new Error('dogeos-core checkout has tracked changes; use the exact clean release source')
}

export function planProofProgramPublication(options: PlanProofProgramPublicationOptions): ProofProgramPublicationPlan {
  const deploymentDir = path.resolve(options.deploymentDir)
  const run = options.run ?? command
  const materials = readProofMaterials(path.resolve(deploymentDir, options.materialsReceipt), deploymentDir)
  const coreRevision = materials.software.sourceRevisions?.dogeosCore
  if (!coreRevision) throw new Error('Proof materials do not record a dogeos-core source revision')
  const coreDir = path.resolve(options.coreDir)
  checkCoreRevision(coreDir, coreRevision, run)
  const publisherScript = path.join(coreDir, 'tools/real-proving/publish-real-proving-bundle.sh')
  const contract = publisherContract(publisherScript)
  const topology = validateProofTopologyBundle(path.resolve(deploymentDir, options.topologyBundle), {preflightOnly: false})
  if (topology.mode !== 'active' || topology.generation !== 'real' || !topology.worker) {
    throw new Error('Program publication requires an installable active/real topology bundle with a Worker contract')
  }

  const productionImage = immutableProofImage(materials.images.productionWorker!)
  if (immutableProofImage(topology.worker.image) !== productionImage) {
    throw new Error('Topology Worker image does not match the validated real proof materials')
  }

  const sources = sourceMap(deploymentDir, materials, topology)
  const files = contract.map(({prefix, relativePath}) => {
    const source = sources.get(relativePath)
    if (!source) throw new Error(`No scrollsdk source mapping for publisher artifact ${relativePath}`)
    return {prefix, relativePath, sha256: sha256(source), sizeBytes: fs.statSync(source).size, source}
  })
  const id = bundleId(files)
  const {config: aws} = readProofAwsConfig(deploymentDir, options.proofAwsConfig)
  return {
    artifactStore: {
      bucket: aws.artifactStore.bucket,
      keyPrefix: `${aws.artifactStore.keyPrefix}/proof-programs/${id}`,
      region: aws.artifactStore.region,
    },
    bundleId: id,
    coreRevision,
    files,
    proofTopologyBundleRevision: topology.manifest.bundle_revision,
    publicEndpointUrl: trimSlash(aws.artifactReadTransport.publicEndpointUrl),
    publisherScript,
    uploadEndpointUrl: proofArtifactS3Endpoint(aws.artifactStore.region),
  }
}

function parsePublisherOutput(body: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of body.trim().split(/\r?\n/u)) {
    const match = /^(DOGEOS_[\dA-Z_]+_(?:URL|SHA256))=(\S+)$/.exec(line)
    if (!match || result.has(match[1])) throw new Error('dogeos-core publisher returned malformed or duplicate output')
    result.set(match[1], match[2])
  }

  if (result.size !== 22) throw new Error(`dogeos-core publisher returned ${result.size} env pairs; expected 22`)
  return result
}

async function anonymousObjectRead(url: string): Promise<{sha256: string; sizeBytes: number}> {
  const response = await fetch(url, {redirect: 'follow'})
  if (!response.ok) throw new Error(`Anonymous artifact GET returned HTTP ${response.status}: ${url}`)
  const body = Buffer.from(await response.arrayBuffer())
  return {sha256: crypto.createHash('sha256').update(body).digest('hex'), sizeBytes: body.length}
}

function stageBundle(files: BundleFile[], root: string): void {
  for (const file of files) {
    const destination = path.join(root, file.relativePath)
    fs.mkdirSync(path.dirname(destination), {recursive: true})
    fs.copyFileSync(file.source, destination, fs.constants.COPYFILE_EXCL)
    if (sha256(destination) !== file.sha256 || fs.statSync(destination).size !== file.sizeBytes) {
      throw new Error(`Staged proof artifact changed during copy: ${file.relativePath}`)
    }
  }
}

export async function publishProofProgramBundle(options: PublishProofProgramOptions): Promise<{
  receipt: ProofProgramPublicationV1
  receiptPath: string
}> {
  const plan = planProofProgramPublication(options)
  const receiptPath = path.resolve(options.deploymentDir, options.output)
  if (fs.existsSync(receiptPath)) throw new Error(`Refusing to overwrite proof publication receipt: ${receiptPath}`)
  fs.mkdirSync(path.dirname(receiptPath), {recursive: true})
  const staged = fs.mkdtempSync(path.join(path.dirname(receiptPath), '.proof-program-publication-'))
  try {
    stageBundle(plan.files, staged)
    const run = options.run ?? command
    const env: NodeJS.ProcessEnv = {...process.env, AWS_REGION: plan.artifactStore.region}
    if (options.awsProfile) env.AWS_PROFILE = options.awsProfile
    delete env.DOGEOS_PROVER_WORKER_TOKEN
    const published = parsePublisherOutput(run(plan.publisherScript, [
      '--bundle-dir', staged,
      '--bucket', plan.artifactStore.bucket,
      '--key-prefix', plan.artifactStore.keyPrefix,
      '--endpoint-url', plan.uploadEndpointUrl,
      '--public-endpoint-url', plan.publicEndpointUrl,
      '--skip-bucket-setup',
    ], {env}))
    const read = options.anonymousRead ?? anonymousObjectRead
    const files: ProofProgramPublicationV1['files'] = {}
    for (const file of plan.files) {
      const url = published.get(`${file.prefix}_URL`)
      const publishedSha = published.get(`${file.prefix}_SHA256`)
      const expectedUrl = `${plan.publicEndpointUrl}/${plan.artifactStore.bucket}/${plan.artifactStore.keyPrefix}/${file.relativePath}`
      if (url !== expectedUrl || publishedSha !== file.sha256) {
        throw new Error(`Publisher output does not bind the staged ${file.relativePath}`)
      }

      const anonymous = await read(url)
      if (anonymous.sha256 !== file.sha256 || anonymous.sizeBytes !== file.sizeBytes) {
        throw new Error(`Anonymous artifact readback mismatch: ${file.relativePath}`)
      }

      files[file.relativePath] = {
        key: `${plan.artifactStore.keyPrefix}/${file.relativePath}`,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        url,
      }
    }

    const receipt: ProofProgramPublicationV1 = {
      artifactStore: plan.artifactStore,
      bundleId: plan.bundleId,
      coreRevision: plan.coreRevision,
      files,
      proofTopologyBundleRevision: plan.proofTopologyBundleRevision,
      publishedAt: new Date().toISOString(),
      schema: PROOF_PROGRAM_PUBLICATION_SCHEMA,
      schemaVersion: 1,
      verification: {anonymousHttpReadback: 'passed', authenticatedS3Readback: 'passed'},
    }
    fs.mkdirSync(path.dirname(receiptPath), {recursive: true})
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx', mode: 0o600})
    return {receipt, receiptPath}
  } finally {
    fs.rmSync(staged, {force: true, recursive: true})
  }
}
