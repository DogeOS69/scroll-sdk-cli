# Bootnode public P2P source allowlist from spec

Use `bootnodePublicP2p` in the deployment spec to expose selected bootnodes to
approved partner **egress IPv4 addresses**. This follows the P2P-only NLB design:
one persistent bootnode identity and one pod per NLB, TCP 30303 only, with RPC,
WebSocket and metrics remaining on the internal Service. HTTP ingress is separate.

Public P2P remains off until the operator explicitly enables a node. Start with:

```yaml
bootnodePublicP2p: []
```

After agreeing the partner source addresses and allocating the deployment's
public subnet/EIP resources, select nodes by the same index as
`identities.bootnodes`. For example (documentation-only addresses and IDs):

```yaml
bootnodePublicP2p:
  - index: 0
    enabled: true
    sourceRanges:
      - 203.0.113.10/32
      - 198.51.100.0/24
    subnets:
      - subnet-0123456789abcdef0
    eipAllocations:
      - eipalloc-0123456789abcdef0
  - index: 1
    enabled: false
```

`/32` allows one source IP; `/24` allows a subnet. These are partner public egress
addresses as observed by the NLB, including NAT gateway addresses when relevant.
They are not enodes, public keys or DNS names. An enode identifies the bootnode
to connect to; source CIDRs decide who may reach its public TCP listener.
The current path supports IPv4, matching the default NLB address family.

The subnet and EIP IDs belong to the deployment's AWS account/region. The CLI
validates their shape and matching counts; it does not allocate or verify ownership
of those resources. Each EIP may be used by only one enabled bootnode entry.
Enable the AZ of the pod's EBS volume on the NLB. With multiple enabled AZs
and one designated pod, also configure cross-zone balancing in reviewed values;
it does not replace enabling the pod AZ. Obtain and verify these IDs with the infrastructure
operator before activation. Existing Services require reviewing the controller's
migration restrictions before changing NLB annotations.

## Existing infrastructure mode

To retain each NLB across bootnode Helm uninstall/reinstall, select
`mode: existing` and the `existingNlb` ARN/security-group references. See the
[existing NLB operator flow](existing-nlb.md), including `setup nlb` preflight,
frontend SG enforcement, persistent node keys and migration. The Service-owned
NLB behavior described below applies to the default `mode: service` only.

## Preparation and installation

Run the normal `scrollsdk setup plan` and `scrollsdk setup apply` workflow. No
`setup bootnode-public-p2p` command is needed; that command is deprecated.
Generation saves the intent in `.data/doge-config.toml` and projects it into
`values/l2-reth-bootnode-production-<index>.yaml`. `setup prep-charts`, including
apply's chart stage, re-applies that intent without replacing the node identity.

An explicit list owns exposure for all bootnodes: omitted or disabled indices
get `reth.p2pExternal.enabled: false`. An empty list disables all public bootnodes.
If the entire field is omitted, the independent manual-values workflow is
preserved; the shipped bootnode template is disabled by default. Repeated
preparation preserves unrelated resource tuning and annotations while reconciling
the selected P2P fields. Sequencer and RPC values are not exposed by this setting.
For an already frozen deployment plan, follow its configuration-update workflow;
do not edit the frozen plan to bypass integrity checks.

Enabled entries require nonempty source CIDRs, subnets and matching EIP
allocations. Invalid, duplicate or out-of-range indices, unrestricted `/0`,
non-IPv4 CIDRs, placeholder resource IDs, reused EIPs, and non-AWS exposure are
rejected. The CLI sets `allowOpenPeering: false`; the spec has no open-peering
option. A broad subnet remains broad permission: approve the actual range, not
merely its syntax.

The existing l2-reth chart renders `spec.loadBalancerSourceRanges`. The AWS Load
Balancer Controller must manage the NLB frontend security group; custom security
group/source-policy bypass annotations are rejected by the chart. See
[AWS source restrictions](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/#lb-source-ranges)
and the SDK chart's activation checklist. Do not disable controller NLB security
groups at cluster level.

Plan/apply generate configuration, not public reachability. Install the reviewed
bootnode Helm releases, then verify both an approved and an unapproved external
source, confirm RPC/WS/metrics are unreachable, and check the expected enode and
block synchronization again after pod rescheduling. This is a public-entry IP
allowlist; it does not block internal ClusterIP peers or replace Reth peer identity
configuration. No live AWS or partner connectivity is established by local tests.
