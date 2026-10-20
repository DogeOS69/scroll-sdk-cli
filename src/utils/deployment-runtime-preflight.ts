/* eslint-disable @typescript-eslint/no-explicit-any -- Kubernetes and JSON-RPC documents are checked at runtime. */
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'

export type ReadCommand = (command: string, args: string[], input?: string) => string
export const readCommand: ReadCommand = (command, args, input) => execFileSync(command, args, {encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000})

export function quantity(value: unknown, cpu = false): number {
  const match = String(value ?? '0').match(/^(\d+(?:\.\d+)?)([EGKMPT]i|[EGMPTk]|m|u|n)?$/)
  if (!match) throw new Error('Unsupported Kubernetes resource quantity')
  const factors: Record<string, number> = {E: 1e18, Ei: 2 ** 60, G: 1e9, Gi: 2 ** 30, Ki: 2 ** 10, M: 1e6, Mi: 2 ** 20, P: 1e15, Pi: 2 ** 50, T: 1e12, Ti: 2 ** 40, k: 1e3, m: 1e-3, n: 1e-9, u: 1e-6}
  return Number(match[1]) * (factors[match[2]] ?? 1) * (cpu ? 1000 : 1)
}

/** Necessary per-pod fit only; this is not a scheduler simulation or an aggregate capacity reservation. */
export function inspectRuntimeManifests(documents: any[], nodes: any[]): string[] {
  const errors: string[] = []
  const ready = nodes.filter(node => !node.spec?.unschedulable && node.status?.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True'))
  for (const document of documents) {
    const pod = document?.kind === 'Pod' ? document.spec : document?.kind === 'CronJob' ? document.spec?.jobTemplate?.spec?.template?.spec : document?.spec?.template?.spec
    if (!pod?.containers) continue
    const candidates = ready.filter(node => Object.entries(pod.nodeSelector ?? {}).every(([key, value]) => node.metadata?.labels?.[key] === value))
    const requests = ['cpu', 'memory'].map(resource => {
      const containerRequest = (container: any) => quantity(container.resources?.requests?.[resource] ?? container.resources?.limits?.[resource], resource === 'cpu')
      let sidecar = 0
      let peakInit = 0
      for (const entry of pod.initContainers ?? []) {
        const amount = containerRequest(entry)
        if (entry.restartPolicy === 'Always') sidecar += amount
        peakInit = Math.max(peakInit, sidecar + (entry.restartPolicy === 'Always' ? 0 : amount))
      }

      const steady = pod.containers.reduce((total: number, entry: any) => total + containerRequest(entry), sidecar)
      return Math.max(steady, peakInit) + quantity(pod.overhead?.[resource], resource === 'cpu')
    })
    if (!candidates.some(node => requests[0] <= quantity(node.status?.allocatable?.cpu, true) && requests[1] <= quantity(node.status?.allocatable?.memory))) errors.push(`${document.kind}/${document.metadata?.name ?? 'unnamed'} CPU/memory requests cannot fit any ready node matching nodeSelector`)
  }

  return errors
}

export function checkClusterManifests(context: string, files: string[], run: ReadCommand = readCommand): string[] {
  const documents = files.flatMap(file => yaml.loadAll(fs.readFileSync(file, 'utf8'))).filter(Boolean) as any[]
  if (documents.length === 0) throw new Error('Runtime preflight requires a nonempty rendered Helm manifest')
  const query = (args: string[]) => JSON.parse(run('kubectl', ['--context', context, ...args, '-o', 'json']))
  const errors = inspectRuntimeManifests(documents, query(['get', 'nodes']).items ?? [])
  const usesAlb = documents.some(doc => doc.kind === 'TargetGroupBinding' || doc.kind === 'Ingress' && (doc.spec?.ingressClassName === 'alb' || doc.metadata?.annotations?.['kubernetes.io/ingress.class'] === 'alb'))
  if (usesAlb) {
    try {
      const controller = query(['-n', 'kube-system', 'get', 'deployment', 'aws-load-balancer-controller'])
      if ((controller.status?.availableReplicas ?? 0) < 1 || (controller.status?.observedGeneration ?? 0) < controller.metadata?.generation) errors.push('AWS Load Balancer Controller is not available at its current generation')
      query(['get', 'crd', 'targetgroupbindings.elbv2.k8s.aws'])
    } catch {errors.push('AWS Load Balancer Controller or TargetGroupBinding CRD is missing or unreadable')}
  }

  return errors
}

const batch = [
  {id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: []},
  ...['latest', 'safe', 'finalized'].map((tag, index) => ({id: index + 2, jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: [tag, false]})),
]
export async function checkEthereumRpcBatch(endpoints: string[], expectedChain: number, quorum: number, request: typeof fetch = fetch): Promise<{checked: number; healthy: number}> {
  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > endpoints.length || new Set(endpoints).size !== endpoints.length) throw new Error('RPC quorum needs distinct endpoints and a valid quorum count')
  const results = await Promise.all(endpoints.map(async endpoint => {
    try {
      const response = await request(endpoint, {body: JSON.stringify(batch), headers: {'content-type': 'application/json'}, method: 'POST', signal: AbortSignal.timeout(15_000)})
      if (!response.ok) return
      const data = await response.json()
      if (!Array.isArray(data) || data.length !== 4 || new Set(data.map(entry => entry.id)).size !== 4) return
      const result = batch.map(call => data.find(entry => entry.id === call.id && entry.jsonrpc === '2.0' && !entry.error)?.result)
      if (Number(result[0]) !== expectedChain || result.slice(1).some(block => !block || !/^0x[\da-f]{64}$/i.test(block.hash) || !/^0x[\da-f]+$/i.test(block.number))) return
      return {endpoint, finalized: result[3]}
    } catch {}
  }))
  const healthy = results.filter(entry => entry !== undefined)
  if (healthy.length < quorum) throw new Error(`Ethereum four-call batch compatibility failed: ${healthy.length}/${endpoints.length} endpoints passed; quorum ${quorum} required (endpoints omitted)`)
  const height = healthy.reduce((minimum, entry) => Math.min(minimum, Number(entry.finalized.number)), Number.MAX_SAFE_INTEGER)
  const hashes = await Promise.all(healthy.map(async ({endpoint}) => {
    try {
      const response = await request(endpoint, {body: JSON.stringify({id: 5, jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: [`0x${height.toString(16)}`, false]}), headers: {'content-type': 'application/json'}, method: 'POST', signal: AbortSignal.timeout(15_000)})
      const data = await response.json()
      return response.ok && data.id === 5 && !data.error && Number(data.result?.number) === height && /^0x[\da-f]{64}$/i.test(data.result?.hash) ? data.result.hash.toLowerCase() : undefined
    } catch {}
  }))
  if (!hashes.some(hash => hash && hashes.filter(other => other === hash).length >= quorum)) throw new Error('Ethereum RPC endpoints do not agree on a common finalized block at the requested quorum')
  return {checked: endpoints.length, healthy: healthy.length}
}

/** Execute a read-only request in the existing signer's network namespace. URL/auth stay on stdin. */
export function checkSignerRpc(container: string, endpoint: string, run: ReadCommand = readCommand): void {
  if (!/^\w[\w.-]*$/.test(container)) throw new Error('Invalid signer container name')
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Signer RPC must use HTTP(S)')
  const user = url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined
  url.username = ''; url.password = ''
  const config = ['silent', 'show-error', 'fail', 'max-time = 15', `url = ${JSON.stringify(url.toString())}`, ...(user ? [`user = ${JSON.stringify(user)}`] : []), 'header = "content-type: application/json"', `data = ${JSON.stringify(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'getblockchaininfo', params: []}))}`].join('\n')
  try {
    const response = JSON.parse(run('docker', ['run', '--rm', '-i', '--network', `container:${container}`, 'curlimages/curl:8.10.1', '--config', '-'], config))
    if (response.error || !response.result?.chain || !Number.isInteger(response.result.blocks)) throw new Error('Invalid response')
  } catch {throw new Error('Dogecoin RPC check failed from the signer container network namespace; endpoint and response omitted')}
}
