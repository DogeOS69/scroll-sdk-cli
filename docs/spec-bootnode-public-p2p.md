# Bootnode public P2P: choose the resource owner

Use `bootnodePublicP2p` in the deployment spec to expose selected bootnodes to
approved partner **egress IPv4 addresses**. This follows the P2P-only NLB design:
one persistent bootnode identity and one pod per NLB, TCP 30303 only, with RPC,
WebSocket and metrics remaining on the internal Service. HTTP ingress is separate.

## Independent NLBs: recommended for stable public endpoints

AWS infrastructure creates one NLB per public bootnode and owns its partner
allowlist. The spec and generated production YAML contain resource references
only. Adding/revoking a partner changes AWS SG rules; no application config change,
Helm upgrade, Reth restart or Cloudflare action is required.

See [the independent NLB runbook](existing-nlb.md) for prerequisites, AWS creation,
resource handoff, installation checks and recurring partner operations.

```yaml
bootnodePublicP2p:
  - index: 0
    enabled: true
    mode: existing
    existingNlb:
      targetGroupArn: REPLACE_WITH_TCP_IP_TARGET_GROUP_ARN
      securityGroupIds: [REPLACE_WITH_NLB_FRONTEND_SG_ID]
```

Do not set `sourceRanges` in existing mode. Empty AWS frontend ingress is a valid
closed endpoint. The CLI checks safe TCP 30303 IPv4 ingress and resource bindings,
not whether an individual partner was approved. Infrastructure owns that decision
and the only partner list. Nonempty legacy spec/values lists must be removed once.
Use the paired CLI and l2-reth 0.1.11 or later supporting this interface.

For an existing deployment, update only the listed bootnodes without rerunning
identity generation or the full preparation workflow:

```bash
scrollsdk setup bootnode-public-p2p --spec ../deployment-spec.yaml --dry-run
scrollsdk setup bootnode-public-p2p --spec ../deployment-spec.yaml
```

The command reads TG → NLB → listener/SG/EIPs from AWS, validates all selected
resources, and updates only `reth.p2pExternal` in existing indexed values files.
It prints enodes using saved public keys in `.data/doge-config.toml`; missing
identities or base files fail without changing the originals. It never installs
Helm, creates AWS resources or rotates keys. Unlisted files remain untouched;
listed disabled entries are disabled (at least one enabled existing entry is
required). YAML formatting/comments may be normalized, but unrelated values are
preserved. Generation is transactional and refuses concurrent values edits.
`--dir`, `--values-dir`, `--doge-config`, `--aws-profile` and `--json` are supported.
Keep the editable spec as the source of truth for future full generation; this
focused command does not rewrite saved preparation plans or saved intent.

`targetGroupArn` and the complete frontend `securityGroupIds` are the only
required AWS resource references. `mode: existing` is optional in the spec when
`existingNlb` is present. Older explicit NLB/listener/subnet/EIP references remain
optional assertions and must match AWS if supplied. The generated production
YAML contains only `targetGroupARN` and `securityGroupIds` under `existingNlb`.
Use the same explicit `--spec` for subsequent `setup nlb` checks.

## Service-owned NLBs: configuration-managed allowlists

The rest of this page describes `mode: service`, including its `sourceRanges`
requirements. Here the Controller creates/manages the NLB from a LoadBalancer
Service. Update the spec, regenerate values and apply the Helm release to change
its partner allowlist; do not manually edit Controller-owned frontend SG rules.
An omitted mode selects existing mode when `existingNlb` is supplied; otherwise it selects service mode for compatibility.

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
    mode: service
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
Enable the Pod/EBS AZ on the NLB. With multiple enabled AZs and one Pod, also
enable cross-zone forwarding; it cannot replace enabling the Pod AZ. Obtain and verify these IDs with the infrastructure
operator before activation. Existing Services require reviewing the controller's
migration restrictions before changing NLB annotations.

## Preparation and installation (service mode)

Run the normal `scrollsdk setup plan` and `scrollsdk setup apply` workflow. No
`setup bootnode-public-p2p` command is used for service mode; it now updates independent NLB bindings only.
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

Enabled service-mode entries require nonempty source CIDRs, subnets and matching EIP
allocations. Invalid, duplicate or out-of-range indices, unrestricted `/0`,
non-IPv4 CIDRs, placeholder resource IDs, reused EIPs, and non-AWS exposure are
rejected. The CLI sets `allowOpenPeering: false`; the spec has no open-peering
option. A broad subnet remains broad permission: approve the actual range, not
merely its syntax.

In service mode the l2-reth chart renders `spec.loadBalancerSourceRanges`. The AWS Load
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
