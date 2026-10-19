# Update bootnode bindings and public enodes

`scrollsdk setup bootnode-public-p2p` prepares selected Reth bootnodes to use
independently managed AWS NLBs. AWS infrastructure must already provide one NLB
per node, a TCP 30303 listener, an IP target group and frontend security groups.
Partner allowlists are maintained only in AWS. This command neither provisions
resources nor deploys Helm or generates private node keys.

## Inputs

The deployment spec needs only these resource references per enabled node:

```yaml
bootnodePublicP2p:
  - index: 0
    enabled: true
    existingNlb:
      targetGroupArn: REPLACE_WITH_TCP_IP_TARGET_GROUP_ARN
      securityGroupIds: [REPLACE_WITH_NLB_FRONTEND_SG_ID]
```

The spec must also identify the AWS account, region, EKS cluster and bootnode
count under `infrastructure`. `mode: existing` is inferred when `existingNlb` is
present. Optional legacy NLB/listener/subnet/EIP references are checked against
AWS if supplied. They are no longer required or copied into generated values.

Start with the existing `values/l2-reth-bootnode-production-<index>.yaml` files
and saved `bootnodeReth.instances[].enodeUrl` entries in `.data/doge-config.toml`.
Missing or malformed input fails before publication; keys are never regenerated.

## Run from the deployment directory

```bash
scrollsdk setup bootnode-public-p2p --spec ../deployment-spec.yaml --dry-run
scrollsdk setup bootnode-public-p2p --spec ../deployment-spec.yaml
```

`--spec` is required so an edited spec cannot be silently replaced by saved
preparation intent. Paths resolve relative to `--dir` (default current directory).
`--values-dir`, `--doge-config`, `--aws-profile`, `--json`, and `--dry-run` are
supported. The command is noninteractive; `-N` is accepted for compatibility.
Old provider/controller-install flags are no longer supported.

The command queries AWS read-only: TG → NLB → listener, SGs, subnets and EIPs.
It validates account/VPC ownership, independent infrastructure, TCP 30303-only
routing and source restrictions, fixed EIPs, health-check/Proxy Protocol settings,
and multi-AZ cross-zone requirements. Empty SG ingress is a valid closed endpoint.
No Kubernetes access is needed for this preparation step.

After every selected node passes validation, a transaction publishes only the
listed nodes' `reth.p2pExternal` changes. Image, genesis, internal peers, resources,
node-key references and other values are preserved. YAML formatting/comments may
be normalized. Repeating an unchanged command produces no file changes.
Unlisted files remain untouched; explicitly disabled listed entries are disabled.
At least one enabled existing NLB entry is required. Concurrent values edits abort
publication instead of overwriting another writer.

Generated production values use the chart's uppercase `ARN` spelling:

```yaml
reth:
  p2pExternal:
    enabled: true
    mode: existing
    ordinal: 0
    existingNlb:
      targetGroupARN: REPLACE_WITH_TCP_IP_TARGET_GROUP_ARN
      securityGroupIds: [REPLACE_WITH_NLB_FRONTEND_SG_ID]
```

Each release uses ordinal zero; the spec index identifies the release. Use the
paired l2-reth chart **0.1.11 or later**. The command does not update chart pins,
Makefiles, saved preparation intent or frozen plans. Keep the editable spec for
future full generation; do not rerun older saved intent that omits this change.

The result prints `enode://<saved-public-key>@<discovered-EIP>:30303`, one per EIP.
This confirms configuration and AWS topology, not an installed or reachable node.
After reviewing the Helm chart version, context and namespace, deploy through
the normal release workflow, then run:

```bash
scrollsdk setup nlb --spec ../deployment-spec.yaml --require-targets
```

Verify partner RLPx identity and block synchronization separately. For external
RPC packages, pass the same `--spec` to `setup gen-rpc-package`; it discovers EIPs
from AWS for existing NLB bindings instead of relying on ClusterIP Service status.

See [the NLB runbook](existing-nlb.md) for AWS prerequisites and recurring
partner changes, and [spec modes](spec-bootnode-public-p2p.md) for the separate
Service-owned NLB workflow. Existing Service-owned public endpoints require an
explicit migration; this command refuses to adopt their resources.
