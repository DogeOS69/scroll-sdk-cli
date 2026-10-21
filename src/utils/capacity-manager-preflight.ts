/* eslint-disable @typescript-eslint/no-explicit-any -- Kubernetes and Helm documents. */
import {randomUUID} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

/** Runs in a disposable Pod with the manager's selectors and Secret references.
 * Deliberately not a local curl or controller-loopback check: those bypass WP's
 * source NetworkPolicy. No credentials are read by the CLI or put in argv.
 */
export function capacityPreflight(plan: any, values: any, run: (args: string[], input?: string) => string): Record<string, unknown> {
  let controller: any
  const controllerOutput = run(['get', 'deployment', plan.dstack.deployment, '-o', 'json'])
  try {controller = JSON.parse(controllerOutput)} catch {throw new Error('Invalid controller deployment response (private contents omitted)')}
  const container = controller.spec?.template?.spec?.containers?.find((c: any) => c.name === 'controller')
  if (!container?.image || !controller.metadata?.uid) throw new Error('Cannot identify deployed dstack controller probe image')
  const name = `cm-preflight-${randomUUID().slice(0, 12)}`
  const script = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/capacity-manager-preflight.py'), 'utf8')
  // Probe the selected immutable manager binary before installing it or creating fleets.
  // --help exits without starting reconciliation or accessing provider credentials.
  const {fallbackFleet} = values.manager.dstack
  if (Boolean(plan.fallbackProvider) !== Boolean(fallbackFleet)) throw new Error('Fallback plan and values differ; prepare capacity-manager again')
  const initContainers = fallbackFleet ? [{args: ['--dstack-fallback-fleet', fallbackFleet, '--help'], command: ['/usr/local/bin/capacity-manager'],
    image: `${values.image.repository}@${values.image.digest}`, name: 'manager-fallback-capability'}] : []
  const env = Object.entries({DSTACK_TOKEN: values.dstackAuth, WORKER_MASTER: values.workerCredentialMaster, WP_TOKEN: values.wpAuth}).map(([name, ref]: [string, any]) => {
    if (!ref?.existingSecret || !ref?.key) throw new Error('Capacity preflight requires all three Secret references')
    return {name, valueFrom: {secretKeyRef: {key: ref.key, name: ref.existingSecret}}}
  })
  env.push({name: 'PROBE_INPUT', value: JSON.stringify({privateDns: plan.privateDns === true, project: plan.project, provider: plan.provider, ...(plan.fallbackProvider ? {fallbackProvider: plan.fallbackProvider} : {}), url: values.manager.dstack.serverUrl, wpUrl: values.manager.proofWorkBaseUrl})} as any)
  const pod = {apiVersion: 'v1', kind: 'Pod', metadata: {labels: {'app.kubernetes.io/instance': 'capacity-manager', 'app.kubernetes.io/name': 'capacity-manager'}, name, namespace: plan.namespace, ownerReferences: [{apiVersion: 'apps/v1', blockOwnerDeletion: false, controller: true, kind: 'Deployment', name: plan.dstack.deployment, uid: controller.metadata.uid}]}, spec: {activeDeadlineSeconds: 120, ...(initContainers.length > 0 ? {initContainers} : {}), automountServiceAccountToken: false, containers: [{command: ['/root/.local/share/uv/tools/dstack/bin/python', '-c', script], env, image: container.image, name: 'probe', readinessProbe: {exec: {command: ['/root/.local/share/uv/tools/dstack/bin/python', '-c', 'raise SystemExit(1)']}, periodSeconds: 1}, resources: {limits: {cpu: '500m', memory: '512Mi'}, requests: {cpu: '50m', memory: '128Mi'}}}], restartPolicy: 'Never'}}
  // A controller reference prevents an existing manager ReplicaSet from adopting
  // this probe with the same labels. Keep it unready to exclude Service traffic.
  // Create (never apply) avoids taking over any existing Pod. Unique name and
  // same namespace/context on every call limit cleanup to this invocation.
  run(['create', '-f', '-'], JSON.stringify(pod))
  try {
    try {run(['wait', '--for=jsonpath={.status.phase}=Succeeded', `pod/${name}`, '--timeout=135s'])} catch {
      let failure: any
      try {failure = JSON.parse(run(['logs', name, '-c', 'probe']))} catch { /* Pending Pods may not have logs. Never return raw output. */ }
      const check = ['controller-version', 'dns', 'dstack-tls-auth-project-backend', 'secret-references', 'wp-capacity-api'].includes(failure?.check) ? failure.check : 'pod-startup-or-completion'
      throw new Error(`Capacity preflight failed at ${check}; check the selected endpoint, synchronized Secrets and network policy (private response omitted)`)
    }

    let result: any
    try {result = JSON.parse(run(['logs', name, '-c', 'probe']))} catch {throw new Error('Capacity preflight did not return a valid result (private logs omitted)')}
    if (result.dns !== 'passed' || plan.privateDns && result.privateDns !== true || result.dstackTlsAuthProjectBackend !== 'passed' || result.wpCapacityApi !== 'passed' || result.secretReferences !== 'passed') throw new Error('Capacity preflight checks did not pass')
    return {dns: result.dns, dstackTlsAuthProjectBackend: 'passed', privateDns: result.privateDns, proofAcceptance: 'not-tested', secretReferences: 'passed', wpCapacityApi: 'passed'}
  } finally {run(['delete', 'pod', name, '--ignore-not-found', '--wait=false'])}
}

/** Bounded, recent log evidence; unknown is not success. Never return raw logs. */
export function capacityReconcileEvidence(logs: string): Record<string, unknown> {
  const lines = logs.split('\n')
  const decisions = lines.filter(line => line.includes('capacity-manager reconcile decision'))
  const errors = lines.filter(line => line.includes('failed to reconcile capacity') || line.includes('per-worker errors') || /reconcile_errors[\s":=]+[1-9]/.test(line))
  const blocked = lines.some(line => /(?:rollout_blocked|scale_down_blocked)[\s":=]+true/.test(line))
  return {controlLoop: errors.length > 0 || blocked ? 'errors-observed' : decisions.length >= 2 ? 'recent-decisions-observed' : 'not-established', decisionSamples: decisions.length, errorSamples: errors.length, gpuAllocation: 'not-verified', proofAcceptance: 'not-verified', windowSeconds: 60}
}
