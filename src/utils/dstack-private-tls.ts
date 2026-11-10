import {X509Certificate} from 'node:crypto'

import type {DstackControllerConfig} from '../types/dstack-controller.js'

import {capacityExec} from './capacity-manager-exec.js'

type Input = NonNullable<DstackControllerConfig['privateTls']>
const DEFAULT_PORT = 8443
const DEFAULT_CLUSTER_DOMAIN = 'cluster.local'

/** dstack-controller chart >= 0.1.7: cert-manager private CA, nginx TLS sidecar, dstack on loopback. */
export function validateDstackPrivateTls(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['clusterDomain', 'port'].includes(key))) throw new Error('Invalid dstackController.privateTls fields')
  const {clusterDomain, port} = input as Input
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1024 || port > 65_535 || port === 3000)) throw new Error('privateTls.port must be an unprivileged port other than 3000')
  if (clusterDomain !== undefined && (typeof clusterDomain !== 'string' || !/^[\da-z](?:[\d.a-z-]*[\da-z])?$/.test(clusterDomain))) throw new Error('privateTls.clusterDomain must be a DNS domain')
}

export function dstackPrivateTlsValues(input: Input): {clusterDomain: string; enabled: true; port: number} {
  validateDstackPrivateTls(input)
  return {clusterDomain: input.clusterDomain ?? DEFAULT_CLUSTER_DOMAIN, enabled: true, port: input.port ?? DEFAULT_PORT}
}

/** The Service name is covered by the chart's server certificate. */
export function dstackPrivateTlsUrl(name: string, namespace: string, input: Input): string {
  return `https://${name}.${namespace}.svc:${dstackPrivateTlsValues(input).port}`
}

/** Prevent stale controller values from leaving dstack on plain HTTP or on a public entry point. */
export function assertDstackPrivateTlsValues(values: {ingress?: {enabled?: boolean}; targetGroupBinding?: unknown; tls?: {enabled?: boolean; port?: number}}, input: Input): void {
  const expected = dstackPrivateTlsValues(input)
  if (values.tls?.enabled !== true || (values.tls.port ?? DEFAULT_PORT) !== expected.port || values.ingress?.enabled || values.targetGroupBinding) {
    throw new Error('Dstack controller values differ from privateTls; regenerate them with prep-charts before preparing capacity-manager')
  }
}

export interface DstackCaTarget {kubeContext: string; namespace: string; secret: string}
/** Returns undefined until cert-manager has issued the controller certificate. */
export type DstackCaReader = (target: DstackCaTarget) => string | undefined
/** Kubernetes could not be asked, as opposed to a Secret that does not exist yet. */
export class DstackCaUnavailable extends Error {}

/** Read only ca.crt from the controller's certificate Secret. The output never includes the key. */
export const readDstackClusterCa: DstackCaReader = ({kubeContext, namespace, secret}) => {
  let encoded: string
  try {
    encoded = capacityExec(['--context', kubeContext, '--namespace', namespace, '--request-timeout', '30s', 'get', 'secret', secret, '--ignore-not-found', '--output', 'jsonpath={.data.ca\\.crt}']).trim()
  } catch {
    throw new DstackCaUnavailable('Cannot read the dstack controller CA from Kubernetes; check the kube context and Secret access (remote details omitted)')
  }

  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined
}

/** Accept only parseable CA certificates, normalized to one PEM bundle. */
export function dstackCaBundle(pem: string): string {
  const blocks = pem.match(/-{5}BEGIN CERTIFICATE-{5}\r?\n[\d\n\r+/=A-Za-z]+-{5}END CERTIFICATE-{5}/g) ?? []
  const rest = blocks.reduce((text, block) => text.replace(block, ''), pem)
  if (blocks.length === 0 || rest.trim() !== '') throw new Error('Dstack controller ca.crt must contain only PEM CA certificates')
  for (const block of blocks) {
    let certificate: X509Certificate
    try {certificate = new X509Certificate(block)} catch {throw new Error('Dstack controller ca.crt contains an unparseable certificate')}
    if (!certificate.ca) throw new Error('Dstack controller ca.crt must contain CA certificates')
  }

  return blocks.map(block => block.replaceAll('\r\n', '\n')).join('\n') + '\n'
}
