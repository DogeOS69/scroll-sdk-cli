import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

import type {DeploymentSpec} from '../types/deployment-spec.js'

const REQUIRED_TEMPLATES = [
  'Makefile.example', 'withdrawal-processor/WithdrawalProcessor.toml',
  'proof-coordinator/ProofCoordinator.toml', 'values/scroll-monitor-production.yaml',
  'values/metrics-exporter-production.yaml',
  'values/l2-reth-sequencer-production.yaml', 'values/l2-reth-bootnode-production.yaml',
  'values/l2-reth-rpc-production.yaml', 'values/l2-reth-rpc-public-production.yaml',
  'values/eth-da-submitter-production.yaml', 'values/fee-oracle-production.yaml',
]

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// These are runtime policy defaults in the projection, not spec-owned inputs.
// Preserve an operator's complete argument list, including an intentionally empty
// list: concatenating flags can change their meaning or introduce duplicates.
const RETH_INPUT_PATHS = new Set([
  'reth.networkId', 'reth.builderGasLimit', 'reth.l1Url', 'reth.sequencer',
  'reth.sequencer.enabled', 'reth.sequencer.feeRecipient',
])
const FEE_ORACLE_INPUTS = new Set([
  'DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL', 'DOGEOS_FEE_ORACLE_L2__CHAIN_ID',
  'DOGEOS_FEE_ORACLE_L2__GAS_ORACLE_CONTRACT', 'DOGEOS_FEE_ORACLE_L2__RPC_URL',
])
function templateOwned(path: string): boolean {
  if (path === 'resources') return true
  if (path.startsWith('reth.')) return !RETH_INPUT_PATHS.has(path)
  const env = path.slice('configMaps.env.data.'.length)
  return path.startsWith('configMaps.env.data.DOGEOS_FEE_ORACLE_') && !FEE_ORACLE_INPUTS.has(env)
}

function mergeValues(base: unknown, override: unknown, project: boolean, explicitPaths: readonly string[] = [], path = ''): unknown {
  if (project && base !== undefined && !explicitPaths.includes(path) && templateOwned(path)) return base
  if (path.split('.').at(-1) === 'env' && Array.isArray(base) && Array.isArray(override)) {
    const entries = new Map(base.filter(entry => object(entry)).map(entry => [entry.name, entry]))
    for (const entry of override.filter(entry => object(entry))) entries.set(entry.name, entry)
    return [...entries.values()]
  }

  if (!object(base) || !object(override)) return override
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].map(field => [field,
    Object.hasOwn(override, field) ? mergeValues(base[field], override[field], project, explicitPaths, path ? `${path}.${field}` : field) : base[field]]))
}

/** Merge operator edits onto SDK defaults, then project deployment inputs. */
export function mergeBootstrapValues(template: string | undefined, generated: string, existing?: string, explicitPaths: readonly string[] = []): string {
  let base = template ? yaml.load(template) : undefined
  if (existing !== undefined) base = mergeValues(base, yaml.load(existing), false)
  return yaml.dump(mergeValues(base, yaml.load(generated), true, explicitPaths), {lineWidth: -1, noRefs: true})
}

/** Resolve a checkout once; callers persist this full commit in the frozen plan. */
export function resolveSdkRevision(sdkDirectory: string, override?: string): string {
  if (override !== undefined && !/^[\da-f]{40}$/.test(override)) throw new Error('templates.sdkRevision must be a full SDK commit hash when supplied')
  try {
    return execFileSync('git', ['-C', sdkDirectory, 'rev-parse', '--verify', `${override ?? 'HEAD'}^{commit}`], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
  } catch {throw new Error('Cannot resolve SDK commit in --sdk-dir')}
}

/** Build a reviewable file plan from committed templates, never a mutable working tree. */
export function planSpecBootstrap(spec: DeploymentSpec, sdkDirectory?: string): Record<string, string> {
  const errors: string[] = []
  if (!sdkDirectory) errors.push('--sdk-dir must point to a local SDK checkout containing that commit')
  if (!spec.identities) errors.push('identities must explicitly declare service and node identity operations')
  if (!spec.proofTopology) errors.push('proofTopology must explicitly select disabled/active, mock/real and observe/enforce')
  for (const service of ['l2Rpc', ...(spec.infrastructure.sequencerCount ? ['l2Sequencer'] : []), ...(spec.infrastructure.bootnodeCount ? ['l2Bootnode'] : [])] as const) {
    const tag = spec.images?.services?.[service as 'l2Rpc']?.tag
    if (!tag || /todo|<|>|\$env:|^latest$/i.test(tag)) errors.push(`images.services.${service}.tag must select an explicit approved Reth release`)
  }

  if (errors.length > 0) throw new Error(`Bootstrap inputs are incomplete:\n- ${errors.join('\n- ')}`)
  const {files, hashes, revision} = loadSdkTemplateFiles(sdkDirectory!, spec.templates?.sdkRevision)
  files.Makefile = adaptNodeCounts(files.Makefile, spec)
  files['.data/spec-bootstrap.json'] = JSON.stringify({
    pendingStages: ['identity provisioning/import', 'contract and genesis generation', 'Bridge initialization and canonical protocol context', 'proof materials, compilation and publication', 'secret preparation and chart reconciliation'], schema: 'dogeos/spec-bootstrap/v1', sdkRevision: revision,
    templateHashes: hashes,
  }, null, 2) + '\n'
  return files
}

/** Read committed SDK templates for every values-generation entry point. */
export function loadSdkTemplateFiles(sdkDirectory: string, revisionOverride?: string): {files: Record<string, string>; hashes: Record<string, string>; revision: string} {
  const revision = resolveSdkRevision(sdkDirectory, revisionOverride)
  const git = (...args: string[]): string => execFileSync('git', ['-C', sdkDirectory, ...args], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']})
  let listing: string
  try {listing = git('ls-tree', '-r', revision, '--', 'examples/')} catch {throw new Error('Pinned SDK commit is unavailable in --sdk-dir')}
  const sourceFiles = new Map(listing.trim().split('\n').filter(Boolean).map(line => {
    const [metadata, name] = line.split('\t')
    return [name.slice('examples/'.length), metadata.split(' ')[0]]
  }))
  const missing = REQUIRED_TEMPLATES.filter(file => !sourceFiles.has(file))
  if (missing.length > 0) throw new Error(`Pinned SDK revision lacks required templates:\n- ${missing.join('\n- ')}`)
  const files: Record<string, string> = {}
  const hashes: Record<string, string> = {}
  for (const [file, mode] of sourceFiles) {
    if (!(file === 'Makefile.example' || file.endsWith('.sh') && !file.includes('/') || /^(?:values|withdrawal-processor|proof-coordinator)\//.test(file))) continue
    if (!['100644', '100755'].includes(mode) || file.split('/').includes('..')) throw new Error(`Unsupported SDK template entry: ${file}`)
    const content = git('show', `${revision}:examples/${file}`)
    hashes[file] = createHash('sha256').update(content).digest('hex')
    files[file === 'Makefile.example' ? 'Makefile' : file] = content
  }

  return {files, hashes, revision}
}

function adaptNodeCounts(source: string, spec: DeploymentSpec): string {
  let lines = source.split('\n')
  const replaceRule = (name: string, body: string): void => {
    const start = lines.indexOf(`${name}:`)
    if (start < 0) throw new Error(`Pinned SDK Makefile lacks ${name}`)
    let end = start + 1
    while (end < lines.length && !/^[a-z][\da-z-]*:/.test(lines[end])) end++
    lines.splice(start, end - start, ...body.trimEnd().split('\n'), '')
  }

  for (const [role, count] of [['sequencer', spec.infrastructure.sequencerCount], ['bootnode', spec.infrastructure.bootnodeCount]] as const) {
    const names = Array.from({length: count}, (_, index) => `l2-reth-${role}-${index}`)
    let inserted = false
    lines = lines.flatMap(line => {
      if (!line.startsWith(`\tvalues/l2-reth-${role}-production-`)) return [line]
      if (inserted) return []
      inserted = true
      return names.map((_, index) => `\tvalues/l2-reth-${role}-production-${index}.yaml \\`)
    })
    const install = `install-l2-reth-${role}:\n\t@set -eu; for index in ${Array.from({length: count}, (_, i) => i).join(' ')}; do \\\n\t\thelm --kube-context "$(KUBE_CONTEXT)" upgrade -i l2-reth-${role}-$$index $(L2_RETH_CHART) -n "$(NAMESPACE)" --version=$(L2_RETH_CHART_VERSION) --values values/l2-reth-${role}-production-$$index.yaml $(L2_RETH_GENESIS_NORMALIZER_ARGS); \\\n\tdone\n\n`
    replaceRule(`install-l2-reth-${role}`, install)
    const remove = `delete-l2-reth-${role}:\n${names.map(name => `\thelm --kube-context "$(KUBE_CONTEXT)" delete -n "$(NAMESPACE)" ${name} || true\n\tkubectl --context "$(KUBE_CONTEXT)" delete pvc -n "$(NAMESPACE)" ${name}-data || true\n`).join('') || '\t@true\n'}\n`
    replaceRule(`delete-l2-reth-${role}`, remove)
  }

  return lines.join('\n')
}
