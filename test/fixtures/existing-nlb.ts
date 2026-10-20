/* eslint-disable @typescript-eslint/no-explicit-any -- Simulated AWS and Kubernetes documents. */
import * as yaml from 'js-yaml'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {applyBootnodePublicP2p} from '../../src/utils/bootnode-public-p2p.js'

// Synthetic account/resource IDs and documentation-only IPs; no live infrastructure.
const prefix = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:'
const lb = `${prefix}loadbalancer/net/bootnode-a/0123456789abcdef`
const listener = `${prefix}listener/net/bootnode-a/0123456789abcdef/fedcba9876543210`
const group = `${prefix}targetgroup/bootnode-a/1111111111111111`
const sg = 'sg-0123456789abcdef0'
const subnet = 'subnet-0123456789abcdef0'
const eip = 'eipalloc-0123456789abcdef0'
export function fixture(): any {
  const entry = {eipAllocations: [eip], enabled: true, existingNlb: {listenerArn: listener, loadBalancerArn: lb, securityGroupIds: [sg], targetGroupArn: group}, index: 0, mode: 'existing', subnets: [subnet]}
  const spec = {bootnodePublicP2p: [entry], infrastructure: {aws: {accountId: '123456789012', eksClusterName: 'example', region: 'us-east-1'}, bootnodeCount: 2, kubeContext: 'example', namespace: 'default', provider: 'aws'}} as DeploymentSpec
  const values = {reth: {nodeKey: {mode: 'secret'}}, role: 'bootnode'}
  applyBootnodePublicP2p(values, 0, spec.bootnodePublicP2p)
  const files = {'l2-reth-bootnode-production-0.yaml': yaml.dump(values)}
  const responses: Record<string, any> = {
    'ec2 describe-security-groups': {SecurityGroups: [{GroupId: sg, IpPermissions: [{FromPort: 30_303, IpProtocol: 'tcp', IpRanges: [{CidrIp: '203.0.113.10/32'}], ToPort: 30_303}], OwnerId: '123456789012', VpcId: 'vpc-example'}]},
    'ec2 describe-subnets': {Subnets: [{AvailabilityZone: 'us-east-1a', OwnerId: '123456789012', SubnetId: subnet, VpcId: 'vpc-example'}]},
    'eks describe-cluster': {cluster: {endpoint: 'https://eks.example.invalid', resourcesVpcConfig: {vpcId: 'vpc-example'}}},
    'elbv2 describe-listeners': {Listeners: [{DefaultActions: [{TargetGroupArn: group, Type: 'forward'}], ListenerArn: listener, LoadBalancerArn: lb, Port: 30_303, Protocol: 'TCP'}]},
    'elbv2 describe-load-balancer-attributes': {Attributes: [{Key: 'load_balancing.cross_zone.enabled', Value: 'false'}]},
    'elbv2 describe-load-balancers': {LoadBalancers: [{AvailabilityZones: [{LoadBalancerAddresses: [{AllocationId: eip, IpAddress: '198.51.100.10'}], SubnetId: subnet, ZoneName: 'us-east-1a'}], IpAddressType: 'ipv4', LoadBalancerArn: lb, Scheme: 'internet-facing', SecurityGroups: [sg], State: {Code: 'active'}, Type: 'network', VpcId: 'vpc-example'}]},
    'elbv2 describe-tags': {TagDescriptions: [{Tags: []}]},
    'elbv2 describe-target-group-attributes': {Attributes: [{Key: 'proxy_protocol_v2.enabled', Value: 'false'}]},
    'elbv2 describe-target-groups': {TargetGroups: [{HealthCheckEnabled: true, HealthCheckPort: 'traffic-port', HealthCheckProtocol: 'TCP', LoadBalancerArns: [lb], Port: 30_303, Protocol: 'TCP', TargetGroupArn: group, TargetType: 'ip', VpcId: 'vpc-example'}]},
    'elbv2 describe-target-health': {TargetHealthDescriptions: [{Target: {Id: '10.0.0.5', Port: 30_303}, TargetHealth: {State: 'healthy'}}]},
    'sts get-caller-identity': {Account: '123456789012'},
  }
  const calls: string[][] = []
  const aws = {json(args: string[]): any {calls.push(args); const key = args.slice(0, 2).join(' '); if (!responses[key]) throw new Error(`Unexpected call ${key}`); return responses[key]}}
  const kubeObjects: Record<string, any> = {
    'config': {clusters: [{cluster: {server: 'https://eks.example.invalid'}}]},
    'endpointslices.discovery.k8s.io': {items: [{endpoints: [{addresses: ['10.0.0.5'], conditions: {ready: true}}], metadata: {ownerReferences: [{kind: 'Service', uid: 'service-uid'}]}, ports: [{port: 30_303, protocol: 'TCP'}]}]},
    'node': {metadata: {labels: {'topology.kubernetes.io/zone': 'us-east-1a'}}},
    'pod': {spec: {nodeName: 'node-a'}, status: {conditions: [{status: 'True', type: 'Ready'}], podIP: '10.0.0.5'}},
    'service': {metadata: {uid: 'service-uid'}, spec: {ports: [{port: 30_303, protocol: 'TCP', targetPort: 30_303}], selector: {'statefulset.kubernetes.io/pod-name': 'l2-reth-bootnode-0-0'}, type: 'ClusterIP'}},
    'targetgroupbindings.elbv2.k8s.aws': {items: [{metadata: {namespace: 'default'}, spec: {networking: {ingress: [{from: [{securityGroup: {groupID: sg}}], ports: [{port: 30_303, protocol: 'TCP'}]}]}, serviceRef: {name: 'l2-reth-bootnode-0-p2p', port: 30_303}, targetGroupARN: group, targetType: 'ip'}}]},
  }
  const kube = (args: string[]): any => kubeObjects[args.includes('config') ? 'config' : args[args.indexOf('get') + 1]]
  return {aws, calls, entry, files, kube, kubeObjects, responses, spec, values}
}
