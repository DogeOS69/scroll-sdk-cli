# Existing ALB mode

Set `infrastructure.aws.alb.mode: existing` to select externally managed ALBs.
Each application chart owns its TargetGroupBindings alongside its ClusterIP
Services and workloads. Managed Ingresses are disabled. Installing or removing
an application does not create/delete the external ALB, listener or target group.
No separate chart or binding release is required.

```yaml
infrastructure:
  provider: aws
  kubeContext: REPLACE_WITH_EKS_CONTEXT
  namespace: default
  aws:
    accountId: "REPLACE_WITH_ACCOUNT_ID"
    eksClusterName: REPLACE_WITH_CLUSTER
    region: us-east-1
    alb:
      mode: existing
      endpoints:
        tso:
          loadBalancerArn: REPLACE_WITH_EXISTING_ALB_ARN
          listenerArn: REPLACE_WITH_EXISTING_HTTPS_443_LISTENER_ARN
      bindings:
        tso-service:
          endpoint: tso
          targetGroupArn: REPLACE_WITH_EXISTING_HTTP_IP_TARGET_GROUP_ARN
          serviceRef:
            name: tso-service
            port: 3000
```

This is a fragment, not a complete deployment spec. Identifiers are placeholders.
Add bindings for enabled HTTP ingresses of the supported applications below,
or disable those not exposed. ALB, listener and target group references are mandatory; the CLI never
falls back to creating resources. The selected SDK commit must contain
the selected applications' `templates/targetgroupbindings.yaml` files. Use the
matching application chart versions from that SDK revision.

Binding keys map to existing application values: `tso-service`,
`proof-coordinator`, `frontends`, `l2-reth-rpc-public`,
`l2-reth-rpc-public-ws`, `blockscout-api`, `blockscout-frontend`.
This workflow does not modify or restrict other applications' ingress settings.
Each binding requires its actual Kubernetes Service name and numeric Service
port. HTTP and WebSocket RPC require separate target groups and distinguishable
host/path rules. All Services use the spec's namespace.

Hosts and paths are taken from existing values, not duplicated in this block.
Generation disables the Ingress and marks it with `existingAlbBinding`, then
writes `targetGroupBindings` into each application's own values file. Both fresh
generation and repeated preparation preserve this boundary. An enabled ingress
in a supported application without a binding is an error. Final AWS spec-based `prep-charts` requires an `alb` selection for those
enabled ingresses; legacy non-spec commands retain their existing behavior.

TLS termination, certificates, DNS, rules, target groups and security groups
belong to external infrastructure. This release supports HTTPS 443 listeners
and HTTP/IP groups in the same AWS account/region/VPC as EKS. TSO and Coordinator
still need separate ALBs, and Coordinator idle timeout is at least 120 seconds.
TSO permits only `/health` and `/signer` (Exact/Prefix as generated); forwarding
the whole service is rejected. Preserve backend security groups and NetworkPolicy:
TSO still requires edge peers when the managed Ingress is disabled.

Disable `preparation.tsoAlbEdge` and configure the chosen ALB's subnet CIDRs in
operator NetworkPolicy values.

Commands, run from the prepared deployment directory:

```bash
# AWS-only read checks. Defaults to frozen .scrollsdk/intent.json, then
# deployment-spec.yaml. --spec and --aws-profile are explicit overrides.
scrollsdk setup alb

# Normal application install: the same release owns the Service and binding.
make install-tso

# After installing all selected applications, check Services/CRD/context.
scrollsdk setup alb --require-services

# Checks references, installed bindings, Services and matching healthy TG targets;
# does not incorrectly require Kubernetes Ingress objects in this mode.
scrollsdk test ingress

# Removes bindings and registered targets, retaining external AWS resources.
make delete-tso
```

`setup alb` validates the ALB ownership tags, VPC/scheme, listener/certificate,
target type, health checks and explicit host/path coverage. It rejects wider
routes to a selected target group and forwarding from another listener. The
Service check also requires the spec's explicit kubeContext to resolve to the
selected EKS cluster. AWS failure details are omitted from normal diagnostics.
Overlapping paths between selected bindings must put the narrower route first;
for example, Blockscout `/api` and `/api/*` must precede the frontend `/*` rule.
These checks do not establish live DNS/TLS/application behavior or exhaustively
analyze priority interactions with unrelated listener rules; validate real
HTTPS requests, denied TSO paths and target health after installation.

`test ingress` additionally requires one live IP TargetGroupBinding per selected
target group with the configured Service name and port. Registered targets must
exactly match the current Service's ready, nonterminating EndpointSlice addresses
and backend ports for the target group's IP family, and all targets must be healthy.
It rejects stale/manual targets, missing registrations and bindings being deleted.
During a rollout, rerun after controller reconciliation and target draining finish.
This requires read access to TargetGroupBindings, Services and EndpointSlices in
the spec namespace. `setup alb --require-services` remains an installation
preflight and does not require the bindings to exist yet.

The controller and CRD must be installed separately. Target groups are exclusive
to one binding; this mode does not support shared groups or manual targets.
The controller needs target registration/deregistration permissions, not ALB
creation/deletion permission for this workflow. Avoid changing a cluster-wide
IAM role blindly if it also manages other workloads.

Uninstalling an application removes its own bindings. Keep the controller
running until binding deletion and target deregistration complete. For an
intentional binding removal without uninstalling the application, disable its
ingress, remove its `existingAlbBinding` marker and `targetGroupBindings` entry
in operator values, remove its spec binding, then regenerate and upgrade that
application release. Stale bindings or markers are rejected.

Offline regression tests render the real SDK application chart from CLI-produced values.
The live acceptance sequence is install → healthy targets → uninstall → same
ALB/listener/TG ARNs with deregistered targets → reinstall → healthy new targets.
Run it in a disposable deployment before production rollout.

References: [AWS lifecycle pattern](https://aws.amazon.com/blogs/containers/patterns-for-targetgroupbinding-with-aws-load-balancer-controller/),
[TargetGroupBinding reference](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/targetgroupbinding/targetgroupbinding/).
