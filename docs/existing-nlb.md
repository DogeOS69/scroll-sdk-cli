# Independently managed bootnode NLBs

Prepare one NLB per public bootnode with the external
[CloudFormation templates](../infrastructure/aws/cloudformation/README.md).
The infrastructure owner controls EIPs, subnets, frontend security groups,
TCP 30303 listener, IP target group, backend access and partner allowlists.
Never share a target group between different node identities. Preserve each
nodekey in its external Secret so the public enode identity survives reinstall.

```yaml
bootnodePublicP2p:
  - index: 0
    enabled: true
    mode: existing
    existingNlb:
      targetGroupArn: REPLACE_WITH_TCP_IP_TARGET_GROUP_ARN
      securityGroupIds: [REPLACE_WITH_NLB_FRONTEND_SECURITY_GROUP_ID]
```

Declare bindings before planning. `setup aws` reads target-group association,
NLB DNS and attached security groups. `setup render` writes these facts into
`values/l2-reth-bootnode-production-<index>.yaml`, preserving unrelated tuning.
The dedicated P2P Service is ClusterIP; its TargetGroupBinding refers to the
external group. The selected SDK must contain the P2P binding chart template.

Partner CIDRs belong to infrastructure, not spec or production values. Leave
`sourceRanges` empty in existing mode. Updating a partner allowlist normally
requires no regeneration or Helm upgrade. Test new connections after revocation;
API success does not prove data-plane propagation or close established peers.

The CLI does not inspect AWS ownership tags, audit IAM or validate security-group
policy, routes, certificates, EIP placement or listener policy. The former
`deployment-preflight --nlb` audit has been removed. Infrastructure operators own
those checks and must verify the NLB and node AZs, cross-zone behavior, TCP health
checks and backend reachability. Install the AWS Load Balancer Controller and
TargetGroupBinding CRD separately.

After normal application installation, verify registered targets against the
actual Pod addresses and port, and test peer connections. `scrollsdk rpc export`
reads the external NLB addresses for the RPC package and preserves the bootnode
public key in the exported enodes. It does not audit partner authorization.

The legacy Service-managed NLB chart remains available for existing deployments;
new externally managed deployments select existing mode explicitly. Changing
resource ownership on a running deployment requires a separate reviewed migration.
Deleting Helm releases removes bindings and registrations; it does not delete
external infrastructure. Keep the controller running until finalizers finish.
