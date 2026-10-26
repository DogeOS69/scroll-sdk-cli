/* eslint-disable @typescript-eslint/no-explicit-any -- Read-only provider JSON. */
import {execFileSync} from 'node:child_process'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {specKubernetesTarget} from './spec-kubernetes-target.js'

export function validateNetworkPolicyIntent(spec: Pick<DeploymentSpec, 'infrastructure'>): void {
  const policy = spec.infrastructure?.networkPolicy
  if (policy === undefined) return // Existing specs remain readable; the explicit preflight requires intent.
  if (policy?.provider !== 'aws-vpc-cni' || spec.infrastructure.provider !== 'aws' || !spec.infrastructure.aws) {
    throw new Error('infrastructure.networkPolicy.provider must be aws-vpc-cni with AWS infrastructure')
  }
}

export type PreflightRead = (program: 'aws' | 'kubectl', args: string[]) => any
export interface NetworkPolicyPreflightOptions {awsProfile?: string; phase: 'infrastructure' | 'workloads'}
const defaultRead: PreflightRead = (program, args) => JSON.parse(execFileSync(program, args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000,
}))
const requireFact = (ok: unknown, message: string): void => {if (!ok) throw new Error(message)}
const ready = (pod: any): boolean => pod.status?.phase === 'Running' && pod.status?.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True')
const agentEnabled = (podSpec: any): boolean => {
  const agent = podSpec?.containers?.find((container: any) => container.name === 'aws-network-policy-agent')
  const args: string[] = agent?.args ?? []
  const flags = args.flatMap((arg, i) => arg === '--enable-network-policy' ? [args[i + 1]] : arg.startsWith('--enable-network-policy=') ? [arg.split('=')[1]] : [])
  return flags.length === 1 && flags[0] === 'true'
}

function selects(selector: any, labels: Record<string, string>): boolean {
  if (!selector || typeof selector !== 'object') return false
  if (!Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value)) return false
  return (selector.matchExpressions ?? []).every(({key, operator, values}: any) => {
    switch (operator) {
      case 'In': { return Object.hasOwn(labels, key) && values?.includes(labels[key])
      }

      case 'NotIn': { return !Object.hasOwn(labels, key) || !values?.includes(labels[key])
      }

      case 'Exists': { return Object.hasOwn(labels, key)
      }

      case 'DoesNotExist': { return !Object.hasOwn(labels, key)
      }

      default: { return false
      }
    }
  })
}

/** Inspect controller/agent and workload policy wiring. Does not test packets or modify the cluster. */
export function checkNetworkPolicy(spec: DeploymentSpec, options: NetworkPolicyPreflightOptions, read: PreflightRead = defaultRead) {
  validateNetworkPolicyIntent(spec)
  requireFact(spec.infrastructure?.networkPolicy?.provider === 'aws-vpc-cni', 'Declare infrastructure.networkPolicy.provider: aws-vpc-cni before running this check')
  const aws = spec.infrastructure.aws!
  const {kubeContext, namespace} = specKubernetesTarget(spec)
  requireFact(kubeContext, 'An explicit infrastructure.kubeContext is required; current-context is never used')
  requireFact(/^\d{12}$/.test(aws.accountId) && aws.region && aws.eksClusterName, 'AWS accountId, region and eksClusterName are required')
  requireFact(['infrastructure', 'workloads'].includes(options.phase), 'phase must be infrastructure or workloads')
  const query = (program: 'aws' | 'kubectl', args: string[], label: string): any => {
    try {return read(program, args)} catch {throw new Error(`Cannot read ${label}; check target, connectivity and read permissions (provider details omitted)`)}
  }

  const awsRead = (args: string[], label: string): any => query('aws', [...args, '--region', aws.region, '--output', 'json', '--no-cli-pager', ...(options.awsProfile ? ['--profile', options.awsProfile] : [])], label)
  const kubeRead = (args: string[], label: string): any => query('kubectl', ['--context', kubeContext!, '--request-timeout=30s', ...args, '-o', 'json'], label)
  const account = awsRead(['sts', 'get-caller-identity'], 'AWS caller identity')
  requireFact(account.Account === aws.accountId, 'AWS caller account does not match the deployment spec')
  const {cluster} = awsRead(['eks', 'describe-cluster', '--name', aws.eksClusterName], 'EKS cluster')
  const arnParts = cluster?.arn?.split(':') ?? []
  requireFact(arnParts[2] === 'eks' && arnParts[3] === aws.region && arnParts[4] === aws.accountId && arnParts[5] === `cluster/${aws.eksClusterName}`, 'EKS cluster identity does not match the deployment spec')
  requireFact(cluster.status === 'ACTIVE', 'EKS cluster must be ACTIVE')
  const context = kubeRead(['config', 'view', '--minify'], 'selected kubeconfig context')
  requireFact(cluster.endpoint && context.clusters?.length === 1 && context.clusters[0].cluster?.server === cluster.endpoint, 'Kubeconfig context does not target the selected EKS cluster endpoint')
  const {addon} = awsRead(['eks', 'describe-addon', '--cluster-name', aws.eksClusterName, '--addon-name', 'vpc-cni'], 'EKS vpc-cni add-on')
  requireFact(addon?.status === 'ACTIVE' && (addon.health?.issues ?? []).length === 0, 'vpc-cni add-on must be ACTIVE without health issues')
  let configuration: any
  try {configuration = JSON.parse(addon.configurationValues || '{}')} catch {throw new Error('vpc-cni configurationValues is not valid JSON')}
  requireFact(configuration.enableNetworkPolicy === 'true' || configuration.enableNetworkPolicy === true, 'vpc-cni enableNetworkPolicy must be explicitly true for the declared enforcer')
  const config = kubeRead(['-n', 'kube-system', 'get', 'configmap', 'amazon-vpc-cni'], 'VPC CNI controller configuration')
  requireFact(config.data?.['enable-network-policy-controller'] === 'true', 'VPC CNI network policy controller is not enabled')
  const ds = kubeRead(['-n', 'kube-system', 'get', 'daemonset', 'aws-node'], 'aws-node DaemonSet')
  const desired = ds.status?.desiredNumberScheduled
  requireFact(desired > 0 && ds.status?.observedGeneration >= ds.metadata?.generation && ds.status?.updatedNumberScheduled === desired
    && ds.status?.numberReady === desired && ds.status?.numberAvailable === desired, 'aws-node rollout is incomplete or no nodes are covered')
  requireFact(agentEnabled(ds.spec?.template?.spec), 'aws-node template does not enable the network policy agent')
  const agents = kubeRead(['-n', 'kube-system', 'get', 'pods', '-l', 'k8s-app=aws-node'], 'aws-node Pods').items
    ?.filter((pod: any) => !pod.metadata?.deletionTimestamp && pod.metadata?.ownerReferences?.some((owner: any) => owner.uid === ds.metadata.uid && owner.kind === 'DaemonSet')) ?? []
  requireFact(agents.length === desired && agents.every((pod: any) => ready(pod) && agentEnabled(pod.spec)
    && pod.status?.containerStatuses?.some((container: any) => container.name === 'aws-network-policy-agent' && container.ready === true)), 'Every aws-node Pod must run a ready, enabled network policy agent')
  const agentNodes = new Set(agents.map((pod: any) => pod.spec.nodeName))
  requireFact(agentNodes.size === desired && !agentNodes.has(undefined), 'aws-node Pods do not cover distinct scheduled nodes')
  const workloads: Array<{pods: number; policies: string[]; service: string}> = []
  if (options.phase === 'workloads') {
    const policies = kubeRead(['-n', namespace, 'get', 'networkpolicies'], 'workload NetworkPolicies').items ?? []
    const endpoints = kubeRead(['-n', namespace, 'get', 'policyendpoints.networking.k8s.aws'], 'AWS PolicyEndpoints').items ?? []
    for (const service of ['tso-service', 'withdrawal-processor']) {
      const pods = (kubeRead(['-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/name=${service}`], `${service} Pods`).items ?? []).filter((pod: any) => !pod.metadata?.deletionTimestamp)
      requireFact(pods.length > 0, `No ${service} Pods found in the deployment namespace`)
      const names = new Set<string>()
      for (const pod of pods) {
        requireFact(ready(pod) && pod.spec?.hostNetwork !== true && agentNodes.has(pod.spec?.nodeName), `${service} must be ready, use Pod networking and run on a node with an enabled policy agent`)
        const matching = policies.filter((policy: any) => !policy.metadata?.deletionTimestamp && selects(policy.spec?.podSelector, pod.metadata.labels ?? {}) && (policy.spec.policyTypes ?? ['Ingress']).includes('Ingress'))
        requireFact(matching.length > 0, `${service} Pod has no selecting ingress NetworkPolicy`)
        for (const policy of matching) {
          names.add(policy.metadata.name)
          requireFact(endpoints.some((endpoint: any) => !endpoint.metadata?.deletionTimestamp && endpoint.spec?.policyRef?.name === policy.metadata.name
            && endpoint.spec.policyRef.namespace === namespace && endpoint.spec.podIsolation?.includes('Ingress')
            && endpoint.spec.podSelectorEndpoints?.some((entry: any) => entry.name === pod.metadata.name && entry.namespace === namespace && entry.podIP === pod.status.podIP)), `${service} NetworkPolicy has no ingress PolicyEndpoint covering its current Pod IP`)
        }
      }

      workloads.push({pods: pods.length, policies: [...names].sort(), service})
    }
  }

  return {accountId: aws.accountId, addonVersion: addon.addonVersion, agentNodes: agentNodes.size, cluster: aws.eksClusterName,
    kubeContext, namespace, observedAt: new Date().toISOString(), phase: options.phase, provider: 'aws-vpc-cni', region: aws.region,
    trafficVerified: false, workloads}
}
