/* eslint-disable @typescript-eslint/no-explicit-any -- Validate rendered Kubernetes objects at this boundary. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {type KubectlRunner, runSecretKubectl} from './dstack-secret-publisher.js'
import {proofRegularFile} from './proof-software-release.js'

const RELEASE = 'cubesigner-signer'
const NAMES = ['cubesigner-signer-env', 'cubesigner-signer-session']
const EXPECTED = NAMES.flatMap(name => [`ExternalSecret/${name}`, `SecretStore/${name}`]).sort()

function runtimeSecretReferences(documents: any[], namespace: string): any[] {
  const resources = documents.filter(doc => ['ClusterSecretStore', 'ExternalSecret', 'SecretStore'].includes(doc?.kind))
  if (JSON.stringify(resources.map(doc => `${doc.kind}/${doc.metadata?.name}`).sort()) !== JSON.stringify(EXPECTED)) throw new Error('Chart must render exactly the two CubeSigner ExternalSecrets and their namespaced SecretStores')
  for (const doc of resources) {
    if (!/^external-secrets\.io\/v1(?:beta1)?$/.test(doc.apiVersion) || (doc.metadata.namespace && doc.metadata.namespace !== namespace)) throw new Error('Unexpected CubeSigner Secret reference API or namespace')
    if (doc.kind === 'ExternalSecret' && (doc.spec?.secretStoreRef?.kind !== 'SecretStore' || doc.spec.secretStoreRef.name !== doc.metadata.name || doc.spec.target?.name !== doc.metadata.name)) throw new Error('CubeSigner ExternalSecret must use its matching namespaced store and target')
    doc.metadata.namespace = namespace
    doc.metadata.labels = {...doc.metadata.labels, 'app.kubernetes.io/managed-by': 'Helm'}
    doc.metadata.annotations = {...doc.metadata.annotations, 'meta.helm.sh/release-name': RELEASE, 'meta.helm.sh/release-namespace': namespace}
  }

  return resources
}

/** Deliver external Secrets without creating a signer workload or authorizing activation. */
export async function prepareCubesignerRuntimeSecrets(options: {
  chart?: string
  chartVersion?: string
  directory: string
  kubeContext: string
  namespace: string
  render?: (args: string[], cwd: string) => string
  runner?: KubectlRunner
  values?: string
}) {
  if (!options.kubeContext.trim() || !/^[\da-z]([\da-z-]*[\da-z])?$/.test(options.namespace) || options.namespace.length > 63) throw new Error('Explicit Kubernetes context and valid namespace are required')
  const root = fs.realpathSync(options.directory)
  const values = proofRegularFile(path.resolve(root, options.values ?? 'values/cubesigner-signer-production.yaml'))
  const render = options.render ?? ((args, cwd) => execFileSync('helm', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000}))
  let documents: any[]
  try {
    documents = yaml.loadAll(render(['template', RELEASE, options.chart ?? 'oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer', '--version', options.chartVersion ?? '0.1.9', '--namespace', options.namespace, '--values', values], root))
  } catch {
    throw new Error('Unable to render CubeSigner Secret references; check the selected chart and values (contents omitted)')
  }

  const resources = runtimeSecretReferences(documents, options.namespace)
  const run = options.runner ?? runSecretKubectl
  const scope = ['--context', options.kubeContext, '--namespace', options.namespace]
  const prefix = [...scope, '--request-timeout=30s']
  // Check all ownership before applying anything. Helm will adopt these objects
  // only after the separate activation check succeeds.
  for (const doc of resources) {
    const text = await run([...prefix, 'get', doc.kind.toLowerCase(), doc.metadata.name, '--ignore-not-found', '-o', 'json'])
    if (!text.trim()) continue
    let live: any
    try {live = JSON.parse(text)} catch {throw new Error('Invalid existing Secret reference readback; contents omitted')}
    const {metadata} = live
    if (metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'Helm' || metadata?.annotations?.['meta.helm.sh/release-name'] !== RELEASE || metadata?.annotations?.['meta.helm.sh/release-namespace'] !== options.namespace) throw new Error('Existing CubeSigner Secret reference belongs to another owner; reconcile it explicitly')
    if (metadata.resourceVersion) doc.metadata.resourceVersion = metadata.resourceVersion
  }

  const payload = JSON.stringify({apiVersion: 'v1', items: resources, kind: 'List'})
  const apply = [...prefix, 'apply', '--server-side', '--field-manager=scrollsdk-cubesigner-secrets', '-f', '-', '-o', 'name']
  await run([...apply, '--dry-run=server'], payload)
  await run(apply, payload)
  await run([...scope, '--request-timeout=130s', 'wait', '--for=condition=Ready', ...NAMES.map(name => `externalsecret/${name}`), '--timeout=120s'])
  return {activation: 'not-verified', context: options.kubeContext, namespace: options.namespace, resources: EXPECTED, workloadStarted: false}
}
