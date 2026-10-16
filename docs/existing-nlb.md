# Independently managed bootnode NLBs

Use one NLB per public bootnode. Each listener is plain TCP 30303 and forwards to
one IP target group containing that bootnode only. Never load-balance different
node identities behind the same enode endpoint. This extends the independent
resource lifecycle in [existing ALBs](existing-alb.md) to P2P; it does not share
an ALB or expose HTTP, WS, metrics, UDP discovery, TLS or Proxy Protocol.

## Responsibilities and prerequisites

The AWS infrastructure operator prepares and retains the NLB, its frontend
security groups, EIPs, public subnets, TCP listener and TCP/IP target group.
Create the NLB with security groups attached; an NLB created without groups cannot
have them attached later. Permit TCP 30303 from exactly the approved partner
IPv4 egress CIDRs across **all** its attached groups. Other inbound ports,
unrestricted/IPv6/group-reference/prefix-list sources are rejected by preflight.
The CLI never creates or changes these resources or their rules.

Prepare a target group in the EKS VPC, port 30303, with TCP health checks on
`traffic-port` and Proxy Protocol v2 disabled. Enable the bootnode Pod/PVC AZ on
the NLB. A single Pod behind multiple NLB AZs requires cross-zone balancing;
cross-zone does not make a disabled Pod AZ usable. Allow backend traffic and
health checks through security-group egress, NACLs and NetworkPolicy. TargetGroupBinding
supplies the NLB groups as backend TCP 30303 ingress sources, reconciled by the
AWS Load Balancer Controller. Its permissions and CRD must already be installed.

Partner companies provide P2P-node public egress CIDRs, including NAT addresses.
They need no AWS account and need not be the attestation-signer companies.
Cloudflare need not change anything for EIP-based enodes. Optional DNS is DNS only;
ordinary orange-cloud HTTP proxying cannot transport TCP 30303.

Persist each node key in its external Secret. Reusing an EIP without the same
node key changes the enode identity. Do not rely on a discarded data PVC to retain
a `pvcAutoGenerate` key.

## Spec and generation

Keep the existing indexed `bootnodePublicP2p` entries. Add `mode: existing` and the
external resource references. Values below are nonfunctional placeholders:

```yaml
bootnodePublicP2p:
  - index: 0
    enabled: true
    mode: existing
    sourceRanges: [203.0.113.10/32] # Replace with approved partner public egress.
    subnets: [REPLACE_WITH_PUBLIC_SUBNET_ID]
    eipAllocations: [REPLACE_WITH_EIP_ALLOCATION_ID]
    existingNlb:
      loadBalancerArn: REPLACE_WITH_NLB_ARN
      listenerArn: REPLACE_WITH_TCP_30303_LISTENER_ARN
      targetGroupArn: REPLACE_WITH_TCP_IP_TARGET_GROUP_ARN
      securityGroupIds: [REPLACE_WITH_NLB_FRONTEND_SECURITY_GROUP_ID]
  - index: 1
    enabled: false
```

For two public bootnodes, give the second entry its own NLB, listener, group and
EIPs. A subnet can be reused, an EIP/NLB/target group cannot. Subnet and EIP lists
must have matching order. ARNs must belong to the configured AWS account/region.
Select the paired SDK revision with `p2p-targetgroupbinding.yaml` (l2-reth 0.1.9
or later with this feature), then run the normal spec preparation commands.
Plan/generation perform local validation; provider verification is the explicit
read-only command below. Do not claim that generating values proves AWS access.

The generated bootnode values retain node identity and unrelated tuning. Existing
mode sets the dedicated P2P Service to ClusterIP and adds a TargetGroupBinding.
Its `sourceRanges` is intent for the infrastructure verifier, **not** a Kubernetes
Service firewall; external frontend SG rules must match. The binding manages
backend ingress from the selected NLB SGs, not partner IPs directly.

`mode: service` (the default if omitted) retains the older Service-owned NLB path.
An `existingNlb` block without existing mode is rejected rather than ignored.
Changing an existing binding to Service mode requires explicit migration; there
is no automatic fallback or provider resource adoption.

## Commands run by the bridge infrastructure operator

From the generated deployment directory, before installing bootnodes:

```bash
scrollsdk setup nlb
```

This verifies identity/account, EKS VPC, external ownership tags, active NLB,
exact frontend SG restrictions, subnet/EIP/AZ mapping, the sole TCP 30303 listener,
its sole IP target group, health checks and Proxy Protocol/cross-zone attributes.
An empty target group is expected before installation. Provider errors are fatal;
there are no automatic repair, create, register or delete calls.

Install with the generated Makefile:

```bash
make install-l2-reth-bootnode
scrollsdk setup nlb --require-targets
```

The second check additionally requires the correct Kubernetes context, one live
binding, a P2P-only Service selecting the designated ordinal, a ready Pod in an
enabled AZ, and exactly that Pod IP/port registered healthy. It does not mistake
healthy stale/foreign targets for readiness. It requires cluster-wide list access
to TargetGroupBindings (to detect competing bindings in other namespaces),
namespace workload reads, and node reads for AZ verification. `--aws-profile`, `--spec`, `--dir`
and `--values-dir` are available when defaults differ.

The command prints the verified EIP endpoints. If `.data/doge-config.toml` has the
saved `bootnodeReth.instances[].enodeUrl`, it also prints public enodes preserving
that public key while replacing only the internal hostname with the EIP:

```text
enode://<unchanged bootnode public key>@<verified EIP>:30303
```

Send the enode and L2 network information to partners. Verify real RLPx identity
and block synchronization from an approved source, and denial from an unapproved
source. A green TCP health check alone is not protocol or source-filter acceptance.

## Migration and reinstall

Do not repoint an old Service-owned NLB by editing its tags or removing Controller
finalizers. That Service owns its old infrastructure. Prepare independent
resources and schedule the cutover. To reuse old EIPs, wait until the old NLB is
deleted and the EIPs are disassociated; otherwise allocate new EIPs and tell partners
the new endpoints, keeping each node public key unchanged.

During application uninstall keep the Controller running until it deregisters the
Pod and removes the binding finalizer. NLB, listener, target group, frontend SGs
and EIPs remain. Reinstall with the same node key and references, then rerun the
post-install check. Do not delete long-lived infrastructure in a Helm cleanup.
Verify this lifecycle on an explicitly authorized disposable deployment; offline
rendering tests do not demonstrate actual AWS uninstall behavior or partner connectivity.
