import {isIPv4} from 'node:net'
import {isDeepStrictEqual} from 'node:util'

import type {DstackControllerConfig} from '../types/dstack-controller.js'

import {AwsCliRunner} from './aws-cli.js'
import {jsonContentEqual} from './json-content.js'

type Input = NonNullable<DstackControllerConfig['internalTls']>
const ALB = 'alb.ingress.kubernetes.io/'
const ARN = /^arn:aws:acm:([a-z]{2}-[a-z]+-\d):\d{12}:certificate\/[\da-f-]+$/

/** A separate opt-in, so existing operator-managed HTTPS endpoints remain valid. */
export function validateDstackInternalTls(input: Input): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['awsProfile', 'certificateArn', 'hostname', 'inboundCidrs', 'subnets'].includes(key))) throw new Error('Invalid dstackController.internalTls fields')
  if (typeof input.hostname !== 'string' || input.hostname.length > 253 || !/^(?:[\da-z](?:[\da-z-]{0,61}[\da-z])?\.)+[a-z]{2,63}$/.test(input.hostname)) throw new Error('internalTls.hostname must be a DNS hostname')
  if (typeof input.certificateArn !== 'string' || !ARN.test(input.certificateArn)) throw new Error('internalTls.certificateArn must identify an ACM certificate in a commercial AWS region')
  if (input.awsProfile !== undefined && (typeof input.awsProfile !== 'string' || !input.awsProfile.trim())) throw new Error('internalTls.awsProfile must be nonempty')
  if (!Array.isArray(input.subnets) || input.subnets.length < 2 || new Set(input.subnets).size !== input.subnets.length || input.subnets.some(id => typeof id !== 'string' || !/^subnet-[\da-f]+$/.test(id))) throw new Error('internalTls.subnets must select at least two unique ALB subnet IDs')
  if (!Array.isArray(input.inboundCidrs) || input.inboundCidrs.length === 0 || input.inboundCidrs.some(cidr => {
    if (typeof cidr !== 'string') return true
    const [address, bits, extra] = cidr.split('/')
    return !isIPv4(address) || extra !== undefined || !/^\d+$/.test(bits ?? '') || Number(bits) < 1 || Number(bits) > 32
  })) throw new Error('internalTls.inboundCidrs must explicitly restrict IPv4 callers')
}

export function dstackInternalIngress(input: Input): NonNullable<DstackControllerConfig['ingress']> {
  validateDstackInternalTls(input)
  return {annotations: {
    [`${ALB}certificate-arn`]: input.certificateArn,
    [`${ALB}healthcheck-path`]: '/healthcheck',
    [`${ALB}inbound-cidrs`]: input.inboundCidrs.join(','),
    [`${ALB}listen-ports`]: '[{"HTTPS":443}]',
    [`${ALB}scheme`]: 'internal',
    [`${ALB}ssl-policy`]: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    [`${ALB}subnets`]: input.subnets.join(','),
    [`${ALB}target-type`]: 'ip',
  }, className: 'alb', enabled: true, hosts: [input.hostname]}
}

/** Read-only provider check; never retrieve or copy certificate private keys. */
export function verifyDstackAcmCertificate(config?: DstackControllerConfig, aws?: Pick<AwsCliRunner, 'json'>): void {
  if (!config?.internalTls || config.enabled === false) return
  const input = config.internalTls
  validateDstackInternalTls(input)
  const region = ARN.exec(input.certificateArn)![1]
  let certificate: {DomainValidationOptions?: Array<{ValidationMethod?: string; ValidationStatus?: string}>; NotAfter?: number | string; Status?: string; SubjectAlternativeNames?: string[]; Type?: string}
  try {certificate = (aws ?? new AwsCliRunner(input.awsProfile)).json(['acm', 'describe-certificate', '--certificate-arn', input.certificateArn], {region}).Certificate} catch {throw new Error('Cannot verify dstack ACM certificate (provider details omitted)')}
  const expiry = typeof certificate?.NotAfter === 'number' ? certificate.NotAfter * 1000 : Date.parse(certificate?.NotAfter ?? '')
  if (certificate?.Type !== 'AMAZON_ISSUED' || certificate.Status !== 'ISSUED' || !(expiry > Date.now())) throw new Error('Dstack TLS requires an unexpired, issued Amazon-managed certificate')
  if (!certificate.DomainValidationOptions?.length || certificate.DomainValidationOptions.some(domain => domain.ValidationMethod !== 'DNS' || domain.ValidationStatus !== 'SUCCESS')) throw new Error('Dstack ACM certificate must use successful DNS validation for managed renewal')
  const covers = certificate.SubjectAlternativeNames?.some(name => name.toLowerCase() === input.hostname || (name.startsWith('*.') && input.hostname.split('.').length === name.split('.').length && input.hostname.endsWith(name.slice(1).toLowerCase())))
  if (!covers) throw new Error('Dstack ACM certificate does not cover internalTls.hostname')
}

/** Prevent stale operator values from silently changing the selected private edge. */
export function assertDstackInternalIngress(values: {ingress?: DstackControllerConfig['ingress']}, input: Input): void {
  const expected = dstackInternalIngress(input)
  const {ingress} = values
  if (!ingress?.enabled || ingress.className !== 'alb' || !isDeepStrictEqual(ingress.hosts, expected.hosts)
    || Object.entries(expected.annotations!).some(([key, value]) => key === `${ALB}listen-ports`
      ? !jsonContentEqual(ingress.annotations?.[key], value) : ingress.annotations?.[key] !== value)
    || ingress.annotations?.[`${ALB}group.name`] || ingress.annotations?.[`${ALB}security-groups`]) throw new Error('Dstack ingress differs from internalTls; regenerate its values before preparing capacity-manager')
}
