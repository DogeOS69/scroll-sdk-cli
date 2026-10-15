/* eslint-disable @typescript-eslint/no-explicit-any -- Certificate and rendered values fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'

import {generateDstackControllerValues} from '../../src/utils/dstack-controller-values.js'
import {assertDstackInternalIngress, verifyDstackAcmCertificate} from '../../src/utils/dstack-internal-tls.js'
import {specDstackController} from '../../src/utils/spec-kubernetes-target.js'

export const internalTls = {certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000', hostname: 'dstack.example.invalid', inboundCidrs: ['10.1.0.0/16'], subnets: ['subnet-aaaa', 'subnet-bbbb']}
describe('dstack internal ALB HTTPS', () => {
  it('generates a private HTTPS-only edge without certificate Secrets or SDK-only config', () => {
    const values = yaml.load(generateDstackControllerValues({internalTls})!) as any
    expect(values).not.to.have.property('internalTls')
    expect(values.ingress).to.include({className: 'alb', enabled: true})
    expect(values.ingress.hosts).to.deep.equal([internalTls.hostname])
    expect(values.ingress.annotations).to.include({'alb.ingress.kubernetes.io/inbound-cidrs': '10.1.0.0/16', 'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}]', 'alb.ingress.kubernetes.io/scheme': 'internal'})
    expect(values.ingress.tls).to.equal(undefined)
    assertDstackInternalIngress(values, internalTls)
    for (const annotation of ['scheme', 'certificate-arn', 'subnets', 'inbound-cidrs', 'listen-ports']) {
      const altered = structuredClone(values); altered.ingress.annotations[`alb.ingress.kubernetes.io/${annotation}`] = 'wrong'
      expect(() => assertDstackInternalIngress(altered, internalTls)).to.throw('differs from internalTls')
    }
  })
  it('requires explicit private-edge inputs and rejects incompatible ingress ownership and AWS region', () => {
    for (const changed of [{hostname: 'https://bad.example.invalid'}, {hostname: 'user:FAKE_PASSWORD@host'}, {subnets: ['subnet-aaaa']}, {inboundCidrs: ['0.0.0.0/0']}, {inboundCidrs: []}, {certificateArn: 'not-an-arn'}, {unknown: true}]) expect(() => generateDstackControllerValues({internalTls: {...internalTls, ...changed}})).to.throw()
    expect(() => generateDstackControllerValues({ingress: {enabled: false}, internalTls})).to.throw('not both')
    expect(() => specDstackController({dstackController: {internalTls}, infrastructure: {aws: {region: 'us-west-2'}}} as any)).to.throw('region must match')
  })
  it('checks issued DNS-validated managed certificates using only describe-certificate', () => {
    const cert: any = {DomainValidationOptions: [{ValidationMethod: 'DNS', ValidationStatus: 'SUCCESS'}], NotAfter: (Date.now() + 86_400_000) / 1000, Status: 'ISSUED', SubjectAlternativeNames: ['*.example.invalid'], Type: 'AMAZON_ISSUED'}
    const aws = {json(args: string[], options: any) {
      expect(args).to.deep.equal(['acm', 'describe-certificate', '--certificate-arn', internalTls.certificateArn])
      expect(options.region).to.equal('us-east-1')
      return {Certificate: cert}
    }}
    verifyDstackAcmCertificate({internalTls}, aws)
    cert.SubjectAlternativeNames = ['*.invalid']
    expect(() => verifyDstackAcmCertificate({internalTls}, aws)).to.throw('does not cover')
    cert.SubjectAlternativeNames = [internalTls.hostname]
    verifyDstackAcmCertificate({internalTls}, aws)
    cert.DomainValidationOptions[0].ValidationMethod = 'EMAIL'
    expect(() => verifyDstackAcmCertificate({internalTls}, aws)).to.throw('DNS validation')
    cert.DomainValidationOptions[0].ValidationMethod = 'DNS'; cert.Type = 'IMPORTED'
    expect(() => verifyDstackAcmCertificate({internalTls}, aws)).to.throw('Amazon-managed')
    cert.Type = 'AMAZON_ISSUED'; cert.NotAfter = '2000-01-01T00:00:00Z'
    expect(() => verifyDstackAcmCertificate({internalTls}, aws)).to.throw('unexpired')
  })
  it('keeps ordinary generation offline and sanitizes provider failures', () => {
    const aws = {json() {throw new Error('FAKE_CREDENTIAL must not appear')}}
    verifyDstackAcmCertificate({}, aws)
    verifyDstackAcmCertificate({enabled: false, internalTls}, aws)
    expect(() => verifyDstackAcmCertificate({internalTls}, aws)).to.throw('provider details omitted')
    expect(() => verifyDstackAcmCertificate({internalTls}, aws)).not.to.throw('FAKE_CREDENTIAL')
  })
})
