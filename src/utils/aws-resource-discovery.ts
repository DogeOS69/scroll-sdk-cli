/* eslint-disable @typescript-eslint/no-explicit-any -- AWS metadata and Helm values. */
import * as toml from '@iarna/toml'
import yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {readAwsResource, readBucketRegion} from './aws-resource-reader.js'
import {localPath, privateWrite, writeJson} from './preparation-io.js'

const RECORD = '.data/aws-resources.json'

/** Collect only facts consumed by configuration. No policy, permission, routing or certificate audits. */
export function discoverAwsResources(root: string, spec: DeploymentSpec, aws = new AwsCliRunner(spec.preparation?.awsIam?.awsProfile)): void {
  const infrastructure = spec.infrastructure.aws!
  const call = (args: string[]) => readAwsResource(aws, args, infrastructure.region)
  const file = localPath(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(file, 'utf8')) as any
  const buckets: Record<string, any> = {}
  for (const [name, store] of Object.entries({archive: config.ethereumDa?.blobArchive?.s3, proof: config.proofArtifacts?.s3, snapshot: config.snapshots?.s3})) {
    if (!store?.bucket) continue
    const region = readBucketRegion(aws, store.bucket, store.region ?? infrastructure.region)
    const previous = store.region ?? infrastructure.region
    store.region = region
    const oldEndpoint = `https://s3.${previous}.amazonaws.com`
    const endpoint = `https://s3.${region}.amazonaws.com`
    if (name === 'archive' && store.publicBaseUrl === `https://${store.bucket}.s3.${previous}.amazonaws.com`) store.publicBaseUrl = `https://${store.bucket}.s3.${region}.amazonaws.com`
    if (name === 'proof') {
      for (const consumer of [config.proofDeployment?.coordinator?.artifactStore, config.proof_topology?.active?.artifactStore]) {
        if (!consumer || consumer.bucket !== store.bucket) continue
        consumer.region = region
        if (!consumer.endpointUrl || consumer.endpointUrl === oldEndpoint) consumer.endpointUrl = endpoint
      }

      if (config.proof_topology?.deployment?.publicS3EndpointUrl === oldEndpoint) config.proof_topology.deployment.publicS3EndpointUrl = endpoint
    }

    buckets[name] = {bucket: store.bucket, region}
  }

  const albs: Record<string, any> = {}
  for (const [name, endpoint] of Object.entries(infrastructure.alb?.endpoints ?? {})) {
    const lb = call(['elbv2', 'describe-load-balancers', '--load-balancer-arns', endpoint.loadBalancerArn]).LoadBalancers?.[0]
    if (!lb?.LoadBalancerArn) throw new Error(`Missing ALB metadata for ${name}`)
    const ids = lb.AvailabilityZones?.map((zone: any) => zone.SubnetId) ?? []
    const subnets = ids.length > 0 ? call(['ec2', 'describe-subnets', '--subnet-ids', ...ids]).Subnets : []
    albs[name] = {arn: lb.LoadBalancerArn, dnsName: lb.DNSName, securityGroupIds: lb.SecurityGroups ?? [], subnetCidrs: subnets.map((subnet: any) => subnet.CidrBlock), vpcId: lb.VpcId}
  }

  const nlbs: Record<string, any> = {}
  for (const entry of spec.bootnodePublicP2p ?? []) {
    if (!entry.enabled || !entry.existingNlb) continue
    const tg = call(['elbv2', 'describe-target-groups', '--target-group-arns', entry.existingNlb.targetGroupArn]).TargetGroups?.[0]
    const arn = entry.existingNlb.loadBalancerArn ?? (tg?.LoadBalancerArns?.length === 1 ? tg.LoadBalancerArns[0] : undefined)
    if (!arn) throw new Error('NLB target group does not identify one load balancer; supply existingNlb.loadBalancerArn')
    const lb = call(['elbv2', 'describe-load-balancers', '--load-balancer-arns', arn]).LoadBalancers?.[0]
    if (!lb?.LoadBalancerArn || !tg?.TargetGroupArn) throw new Error('Missing NLB or target group metadata')
    nlbs[entry.index] = {dnsName: lb.DNSName, loadBalancerArn: lb.LoadBalancerArn, securityGroupIds: lb.SecurityGroups ?? [], targetGroupArn: tg.TargetGroupArn}
  }

  privateWrite(file, toml.stringify(config))
  writeJson(localPath(root, RECORD), {albs, buckets, nlbs, schema: 'scrollsdk/aws-resources/v1'})
}

/** Metadata contributes the infrastructure-owned fields; preserve all other operator values. */
export function projectDiscoveredAwsValues(root: string, directory: string, spec: DeploymentSpec): void {
  const file = localPath(root, RECORD)
  if (!fs.existsSync(file)) return
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  const tso = spec.infrastructure.aws?.alb?.bindings['tso-service']
  if (tso && record.albs[tso.endpoint]) {
    const target = path.join(directory, 'tso-service-production.yaml')
    if (fs.existsSync(target)) {
      const values: any = yaml.load(fs.readFileSync(target, 'utf8'))
      values.networkPolicy ??= {}; values.networkPolicy.allowFrom ??= {}
      // This field represents the selected ALB's subnet peers, not a policy audit.
      values.networkPolicy.allowFrom.edge = record.albs[tso.endpoint].subnetCidrs.map((cidr: string) => ({ipBlock: {cidr}}))
      privateWrite(target, yaml.dump(values, {lineWidth: -1, noRefs: true}))
    }
  }

  for (const [index, nlb] of Object.entries(record.nlbs) as Array<[string, any]>) {
    const target = path.join(directory, `l2-reth-bootnode-production-${index}.yaml`)
    if (!fs.existsSync(target)) continue
    const values: any = yaml.load(fs.readFileSync(target, 'utf8'))
    values.reth ??= {}; values.reth.p2pExternal ??= {}
    values.reth.p2pExternal.existingNlb = {securityGroupIds: nlb.securityGroupIds, targetGroupARN: nlb.targetGroupArn}
    privateWrite(target, yaml.dump(values, {lineWidth: -1, noRefs: true}))
  }
}
