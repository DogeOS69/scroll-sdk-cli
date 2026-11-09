# Prepare AWS resources before genesis

These CloudFormation templates prepare infrastructure independently of Scroll SDK
genesis, Bridge funding, configuration rendering and Helm installation. Operators
review a change set and explicitly execute it. There is no deploy-all script.

The staged CLI consumes these outputs through explicit spec references. `setup aws`
reads existing AWS resource metadata before genesis and records bindings locally;
it does not create resources, adopt roles or update policies. Keep CloudFormation
as the owner. The output JSON below is a handoff artifact, not a `--resources`
CLI input; `setup import-aws` imports its references into the operator spec.

## Template organization

Each template describes one kind of resource. Deploy one stack per instance:
one per signing identity, one per ALB, one per HTTP target, one per bootnode NLB.
Stacks are ordinary, self-contained CloudFormation templates; there is no
generator, nested-stack publication or deploy-all engine.

Resources that already exist are not referenced through wrapper stacks. Adopt
them with a reviewed CloudFormation resource import kept in that environment's
private repository, and give the adopted stacks the same output names as these
templates so `setup import-aws` can read them (use a source `prefix` when one
stack holds several resources of the same kind).

Keep application HTTP targets/routes (`http-target.yaml`, `http-route.yaml`),
backend access rules and shared ESO reader grants under their actual owners.
Repeated peer allowlist edits belong to the network owner's reviewed change set;
password rotation belongs to the secret owner and the affected service, not to
re-creating infrastructure or signing identities.

## Ownership and scope

Use a stable infrastructure environment name, such as `dogeos-testnet`. Changing
an application release, rehearsal date or local deployment directory must not
create a new infrastructure stack. A new chain identity requires a deliberate
decision about which keys and resources to reuse.

| Template | Resources created when explicitly deployed | Existing inputs |
| --- | --- | --- |
| `signing-key.yaml` | One signing KMS key and alias, retained on deletion | Operator-selected alias name |
| `application-roles.yaml` | Six application roles and Pod Identity associations (optional IRSA); fixed two-sequencer example | Five signing key ARNs, two bucket names/prefixes, EKS cluster |
| `pod-identity-agent.yaml` | One cluster-level EKS Pod Identity Agent add-on | Existing cluster and explicitly selected compatible add-on version |
| `vpc-cni.yaml` | The cluster's Amazon VPC CNI add-on with NetworkPolicy enforcement, retained on deletion | Existing cluster and its add-on version; usually imported, see [NetworkPolicy enforcement](#networkpolicy-enforcement) |
| `secrets-reader-policy.yaml` | One deployment-scoped read policy attached to an existing ESO role; preserves trust/other grants | Existing role name, Secret prefix, optional Secret encryption key |
| `secrets-reader-role.yaml` | One deployment-scoped External Secrets IRSA reader role | Secret prefix/region, OIDC provider, optional Secret encryption key |
| `dstack-role.yaml` | One dstack controller role; **zero GPU instances** | EKS cluster, VPC, two or three eligible private worker subnets, optional worker instance profile/role |
| `https-alb.yaml` | One ALB, one HTTPS listener, one SG, optional client ingress rule; optionally one exact-host private DNS zone and alias | VPC, two or three subnets, ACM certificate |
| `http-target.yaml` | One HTTP/IP target group and one host/path forwarding rule; **zero ALBs** | ALB listener, VPC, hostname, application port/health settings |
| `proof-secret.yaml` | Empty Secrets Manager Secret metadata, retained on deletion | Environment and Secret prefix |
| `http-route.yaml` | Additional host/path rule to an existing target group | Listener and target-group ARN |
| `backend-access.yaml` | Explicit backend SG ingress and optional LB SG egress | Actual node/Pod SG, LB SG, actual Pod port range |
| `bootnode-nlb.yaml` | One NLB, TCP listener, TCP/IP target group, SG and optional peer rule; **zero EIPs** | VPC, two public subnets, two unused EIP allocations |

Buckets are always supplied by the operator; their policies belong to the bucket
owner, such as the environment's adopted storage stack. Do not give two stacks
ownership of the same bucket policy. The templates do not create EKS, VPCs, NAT gateways, databases, certificates, OIDC
providers, Secret values, application Kubernetes objects, or GPU workers. The
optional Pod Identity Agent add-on runs a DaemonSet on existing cluster nodes;
`vpc-cni.yaml` manages the cluster's existing VPC CNI add-on.
The other dependencies are existing
platform resources or belong to later runtime stages. A dstack fleet is managed
by dstack, not represented as a static EC2 instance in this pack.

For the current two-sequencer topology, the five signing identities are ETH DA,
Fee Oracle, L2 sequencer 0, L2 sequencer 1, and the Dogecoin Bridge sequencer used
by Withdrawal Processor. P2P nodekeys and CubeSigner keys are not these KMS keys.
The optional Secrets Manager encryption key is a separate symmetric key.

Do not recreate existing keys or load balancers to adopt this pack; import them
as described above. Never have the CLI, Terraform, CloudFormation and a Kubernetes Ingress controller
manage the same resource properties simultaneously.

The six application roles are intentionally readable, fixed examples. For a
different sequencer count, explicitly add/remove matching role declarations,
parameters and outputs before reviewing the change set. Role names are assigned
by CloudFormation; consumers use output ARNs. They do not use the CLI ownership
tag. Every tagged resource has Environment, Purpose, Name and ResourceClassification tags; Environment is a
required stable input and Purpose identifies its logical function.

## Workload identity

New environments use `WorkloadIdentity=pod-identity` and `ClusterName` on
`application-roles.yaml` and `dstack-role.yaml`, paired with
`infrastructure.aws.workloadIdentity: pod-identity` in the deployment spec.
The templates own IAM permissions, role trust and EKS associations. Role trust
is restricted to the exact cluster ARN, namespace and ServiceAccount session tags.
The CLI reads the associations and records the selected role and association ID;
it does not create them, simulate permissions or audit trust policies.

CLI rendering pins ServiceAccount names and removes the workload's old
`eks.amazonaws.com/role-arn` annotation while preserving other annotations.
Proof S3 access uses `ambient` (the AWS SDK default credential chain), and dstack
uses default credentials. Existing charts support these ServiceAccounts; no
application chart change is required. Shared ESO still uses its independent IRSA
reader and SecretStore authentication. Do not remove its role annotation.

To migrate an existing environment, update its existing role stacks in place;
review changes to trust and additions of associations. Preserve logical IDs,
role ARNs, KMS identities, buckets and prefixes. Regenerate production values and
recreate application Pods through the normal Helm rollout: existing Pods retain
their previous credential environment. Remove explicit AWS keys, web-identity
environment variables and mounted credential files from migrated application
Pods. `WorkloadIdentity=irsa` plus `OidcIssuer` remains available for deliberate
legacy use; an omitted CLI spec field preserves the previous IRSA behavior.

Install the EKS Pod Identity Agent once per cluster with `pod-identity-agent.yaml`
if neither an existing add-on nor EKS Auto Mode provides it. Select its version
with `aws eks describe-addon-versions` for the cluster version. It uses
`ResolveConflicts: NONE` and does not modify node IAM policies; nodes need
`eks-auth:AssumeRoleForPodIdentity` and connectivity to EKS Auth. See
[AWS Agent setup](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-agent-setup.html)
and [trust policy conditions](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html).

## NetworkPolicy enforcement

The CLI renders Kubernetes NetworkPolicies (TSO, Withdrawal Processor and other
services), but on EKS they are enforced only when the Amazon VPC CNI network
policy controller and node agent are on. Without them a cluster accepts the
policies and ignores them. `vpc-cni.yaml` owns that switch:
`EnableNetworkPolicy=true` sets the add-on configuration
`{"enableNetworkPolicy":"true"}`.

Every EKS cluster already runs the VPC CNI. Do not create a second owner:

- **Existing managed add-on** (the usual case; `aws eks describe-addon
  --addon-name vpc-cni` succeeds): import it, then change the switch.
  1. In a private copy of the template, remove `Outputs` (an IMPORT change set
     may only import resources) and set `AddonVersion` to the installed version.
     If the add-on already has `configurationValues`, add those keys to
     `ConfigurationValues` so they are kept.
  2. IMPORT change set with `EnableNetworkPolicy` matching the current value
     (`false` when unset). It imports one resource and changes nothing:
     ```bash
     aws cloudformation create-change-set \
       --stack-name "$INFRA_STACK" --change-set-name "$INFRA_CHANGESET" \
       --change-set-type IMPORT --template-body "file://$INFRA_DIR/vpc-cni.yaml" \
       --parameters "file://$INFRA_DIR/vpc-cni.json" \
       --resources-to-import '[{"ResourceType":"AWS::EKS::Addon","LogicalResourceId":"VpcCni","ResourceIdentifier":{"ClusterName":"your-cluster","AddonName":"vpc-cni"}}]'
     ```
  3. UPDATE change set with the unmodified template and `EnableNetworkPolicy=true`.
     Expect one `Modify` of `VpcCni`, no replacement. This also adds `Outputs`
     and the tags.
- **Self-managed VPC CNI** (no managed add-on): migrate to the managed add-on
  first, following the AWS guide; this template uses `ResolveConflicts: NONE`
  and does not overwrite self-managed fields.

Before setting `true`:

- Review every NetworkPolicy in the cluster (`kubectl get networkpolicy -A`).
  Each one starts denying traffic it does not allow, including policies
  installed long ago. Check that monitoring, ingress controllers, load balancer
  health checks and DNS are allowed where a policy selects the Pod.
- Use a supported version: VPC CNI v1.14 or later on a supported Kubernetes
  version (see the AWS guide).
- Pod networking permissions (`AmazonEKS_CNI_Policy`) stay where they are now,
  normally on the node role. The template does not set a ServiceAccount role.

Executing the UPDATE rolls the `aws-node` DaemonSet one node at a time and starts
enforcement. Afterwards declare `infrastructure.networkPolicy.provider:
aws-vpc-cni` in the deployment spec and run
`scrollsdk check network-policy --spec <spec> --phase infrastructure` (then
`--phase workloads` after install). Rollback: UPDATE with
`EnableNetworkPolicy=false`. Deleting the stack retains the add-on. See
[EKS network policies](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html).

## Prepare inputs

Keep actual parameter files, stack outputs and environment records in a private
operator directory outside this public checkout. The files under `parameters/`
contain nonfunctional placeholders. They are not deployable environment files.

For a new environment, copy the required `parameters/*.example.json` files into
that private directory and edit those copies. Shared templates do not need
environment-specific edits. For example, five private signing-key parameter
files can set `Environment=dogeos-testnet-cluster` and these `AliasName` values:

| Identity | Example `AliasName` |
| --- | --- |
| ETH DA | `alias/testnet/dogeos-testnet-cluster/eth-da-submitter` |
| Fee Oracle | `alias/testnet/dogeos-testnet-cluster/fee-oracle` |
| Sequencer 0 | `alias/testnet/dogeos-testnet-cluster/sequencer-0` |
| Sequencer 1 | `alias/testnet/dogeos-testnet-cluster/sequencer-1` |
| Bridge | `alias/testnet/dogeos-testnet-cluster/bridge-sequencer` |

Aliases are operator-selected; `alias/dogeos/` in the skeleton is only an
example. Include the `alias/` prefix in parameter files (the KMS console omits
it when displaying names). Names must be unique within the AWS account and
region; `alias/aws/` is reserved. See the
[AWS alias naming rules](https://docs.aws.amazon.com/kms/latest/APIReference/API_CreateAlias.html).
A key stack does not adopt an existing alias automatically. Reapply changes to the same environment's stack instead of creating another stack for
each deployment. `Environment` is a separate stable identifier (letters,
digits and hyphens), not the slash-separated alias path.

1. Select the AWS account/profile and region, existing EKS cluster and namespace.
   Use Pod Identity for application and dstack roles. ServiceAccount names must
   match the rendered Helm releases. For shared ESO or explicit legacy IRSA,
   read the OIDC issuer, supply it **without `https://`**, and use the existing
   IAM OIDC provider.
2. Record the signing key ARNs from the key stack outputs. Verify `ECC_SECG_P256K1`, `SIGN_VERIFY`, enabled
   status, public keys and expected addresses. These templates use same-account
   role/key access; existing key policies must permit the selected roles or
   account IAM delegation. An IAM role policy alone cannot override a key policy.
3. Select archive/proof buckets and nonempty prefixes. Existing bucket policies,
   public-read/provider access and any SSE-KMS encryption permissions remain the
   bucket owner's responsibility. IAM grants here do not make artifacts publicly
   downloadable. DA's role can also read/write the two proof segmentation sidecar
   namespaces, matching the CLI contract. Coordinator may list/delete its proof
   prefix; WP cannot list/delete it.
4. Set a stable Secret prefix. Put all deployment Secrets, including the proof
   token Secret, under that prefix (the CLI's `preparation.proofAws.secretName`
   can select its name); see [ESO reader access](#eso-reader-access).
   Align SecretStores and remote references. The reader cannot create/upload
   secrets or list all account Secrets. A different operator identity uploads
   contents later. Preserve an existing role with `secrets-reader-policy.yaml`, or
   explicitly bind a new deployment-scoped role from `secrets-reader-role.yaml`.
   The managed policy has a lifecycle description and stack
   ownership; apply Environment/ResourceClassification tags through `aws iam tag-policy`
   if the CloudFormation resource does not propagate them. EC2 rules created by
   standalone ingress/egress resources also need `aws ec2 create-tags` when lifecycle
   tags are not propagated; select only the rule IDs from these stacks, using their
   environment-marked descriptions. Do not retag shared roles or unrelated rules.
5. Verify that all LB subnets are in the selected EKS VPC, with two different AZs,
   and that ACM certificates are issued in the ALB region and cover the hosts.
   Public ALBs/NLBs require public subnet routing. Internal ALBs require the
   intended private routing. No template derives or broadens a client allowlist.
6. Worker private subnets need usable outbound connectivity (for example, an
   existing NAT path) and access to the dstack endpoint and proof services. The
   dstack backend's eligible subnet set must match the subnets allowed by the
   role; otherwise a launch in an unapproved subnet will fail. Add approved
   subnet ARNs explicitly for a larger topology. Multi-region workers require
   extending the role's region/resource scope. This template does not permit
   allocating public EIPs. Optional instance-profile PassRole is exact-role only.

The dstack policy follows the existing CLI's dstack 0.21.5 permission contract:
instance creation requires `owner=dstack` and the selected `dstack_project`, and
management of tagged resources is project scoped. RunInstances dependencies need
some account/region-wide resource patterns. Placement groups are region/account
scoped because that dstack version does not tag them. This is not a complete
tenant-isolation boundary or a hard cost limit. Capacity Manager's runtime worker
limits and budget remain separate configuration.

## Resource layout and routing

Keep durable signing identities separate from replaceable application edges.
Create one signing-key stack per identity. Keys and aliases use `Retain` on deletion/replacement:
retained resources stay in AWS and must remain in the resource inventory. This
does **not** make changing the key identity safe. Reject unintended key
replacements during change-set review.

Create one `https-alb` stack per intended ingress boundary, then one `http-target`
stack per backend service. Multiple HTTP targets can use the same ALB listener;
the route template does not create another ALB.

| Endpoint | ALB arrangement | Route/health parameters |
| --- | --- | --- |
| TSO | Dedicated internet-facing ALB | `ServiceKind=tso`, port 3000, health `/health`; routes fixed to `/health`, `/signer`, `/signer/*` |
| Proof Coordinator | Separate internet-facing ALB | `ServiceKind=generic`, port 7788, health `/healthz`, routes matching the rendered ingress (normally `/*`) |
| RPC, Portal, Blockscout | May share another ALB | Separate target groups, exact hosts, ports/health checks from rendered values |
| dstack | Internal ALB | Port 3000, health `/`, `/*`; private DNS hostname must match route and certificate |
| Public bootnode | Independent NLB per selected bootnode | TCP30303 only, no Proxy Protocol, cross-zone enabled for the single-node backend |

These are the current CLI/chart contracts, not a universal AWS restriction. TSO
and Proof Coordinator must not share an ALB in the current existing-ALB workflow.
ALB idle timeout is 120 seconds. The listener's default response is 404; generic
routes require an exact host and explicit path patterns. Use at most three path
patterns per rule. Blockscout `/api` and `/api/*` rules must precede overlapping
frontend `/*` rules. Priorities must be unique on the listener.

Enable every Availability Zone where backend Pods can run. For a three-zone
cluster, set the optional `SubnetC` as well
as `SubnetA` and `SubnetB`, with one subnet per zone. An IP target in an unenabled
zone is unused even when its health endpoint works. Adding the third subnet
updates the existing ALB without replacing it.

`https-alb.example.json` demonstrates the **internal dstack** edge. For public
services, explicitly change Scheme, subnets, certificate, permitted client CIDR,
backend range/ports, and clear PrivateHostname. Do not blindly deploy that
example for TSO. Empty client/peer CIDR creates a closed endpoint. For multiple
approved ranges, add explicit SG ingress resources in the reviewed template;
do not replace several narrow ranges with a broader range merely to fit one
parameter. Verify `BackendPortFrom <= BackendPortTo` and permit only the actual
backend/health ports. This pack uses IPv4.

Public DNS is external. Optional dstack private DNS creates an exact-host zone;
leave it off if the hostname is already managed by an existing private zone.
The existing VPC must have DNS support/hostnames enabled and the intended callers
must resolve the private name. Creating a zone does not configure an ACM
certificate or public validation records.

ALB/NLB SG egress permits the configured backend range/ports. **Backend ingress
must also be prepared:** authorize the LB SG on the actual node/Pod SG and align
Kubernetes NetworkPolicy. The application ALB TargetGroupBinding templates do not
manage those SG rules. TSO needs its ALB subnet CIDRs in edge NetworkPolicy even
when Ingress is disabled. Disable controller-managed Ingress/LoadBalancer Service
creation when selecting externally managed LBs. Targets remain empty until the
controller binds the installed services.

## Review and execute one stack

Use the AWS CLI already authenticated for the intended account. The commands
below are operator instructions, not actions performed by this repository.
Run them from this directory after replacing placeholders in a private copy.

```bash
export AWS_PROFILE=your-existing-profile
export AWS_REGION=your-selected-region
export INFRA_DIR=/absolute/private/operator/environment
export INFRA_STACK=dogeos-testnet-application-roles
export INFRA_CHANGESET=review-001

aws sts get-caller-identity

# Local checks, no AWS calls. See requirements-dev.txt below.
python validate_parameters.py application-roles.yaml "$INFRA_DIR/application-roles.json"
cfn-lint application-roles.yaml

# CREATE for a genuinely new stack; UPDATE for this environment's existing stack.
# Creating a change set records a proposal; it does not execute resource changes.
aws cloudformation create-change-set \
  --stack-name "$INFRA_STACK" \
  --change-set-name "$INFRA_CHANGESET" \
  --change-set-type CREATE \
  --template-body file://application-roles.yaml \
  --parameters "file://$INFRA_DIR/application-roles.json" \
  --capabilities CAPABILITY_IAM \
  --tags Key=ManagedBy,Value=dogeos-cloudformation

aws cloudformation wait change-set-create-complete \
  --stack-name "$INFRA_STACK" --change-set-name "$INFRA_CHANGESET"
aws cloudformation describe-change-set \
  --stack-name "$INFRA_STACK" --change-set-name "$INFRA_CHANGESET"
```

Review **Add / Modify / Remove / Replacement** and IAM policy changes. This
application-role template adds six roles to a new stack; an ordinary app render
does not need a stack update. A failed change-set waiter can mean "no changes"
or a real error: inspect StatusReason, do not automatically retry with a new stack
name. Enable stack termination protection for durable stacks through the AWS
console or CLI when supported by the stack's current status.

Only after approving that specific change set:

```bash
aws cloudformation execute-change-set \
  --stack-name "$INFRA_STACK" --change-set-name "$INFRA_CHANGESET"
aws cloudformation wait stack-create-complete --stack-name "$INFRA_STACK"

# For UPDATE use stack-update-complete instead.
aws cloudformation describe-stacks --stack-name "$INFRA_STACK" \
  --query 'Stacks[0].Outputs' --output json \
  > "$INFRA_DIR/$INFRA_STACK.outputs.json"
```

For another template, use its own stable stack name and parameter file. Deploy
keys only if needed, then roles; ALB listeners precede their route stacks.
References are passed explicitly, not through a deploy-all loop. Retain the
account, region, stack ID, resource ownership and outputs in the environment
inventory. ALBs/NLBs have deletion protection enabled; teardown requires an
explicit reviewed change to disable that protection, followed by dependent-route
cleanup and stack deletion. Retained keys are never part of routine app teardown.

## Handoff to application configuration

Outputs contain only public resource references, never secret values. Keep them
in the operator directory. Use `scrollsdk setup import-aws` to import these
references before `setup plan`. Copy [spec-import.example.yaml](parameters/spec-import.example.yaml),
select stack names or saved output files, then preview and explicitly write:

```sh
scrollsdk setup import-aws --manifest infrastructure/spec-import.yaml --spec deployment-spec.yaml
scrollsdk setup import-aws --manifest infrastructure/spec-import.yaml --spec deployment-spec.yaml --write
```

Existing different references require `--replace`. Writes back up the original
spec; unchanged imports are no-ops. See [import mapping and preservation rules](../../../docs/import-aws.md).
Frozen plans and generated values are not modified.

| Output/input | Consumer |
| --- | --- |
| Signing `KeyArn` | `identities.*.kms.keyId`, or `preparation.bridge.production.sequencerKms.keyId`; select reuse and the correct key region |
| Application `*RoleArn` | `infrastructure.aws.roles.{ethDaSubmitter,feeOracle,proofCoordinator,withdrawalProcessor,sequencers}`; Pod Identity uses associations, while IRSA uses annotations |
| Dstack controller `RoleArn` | `infrastructure.aws.roles.dstackController` |
| Secret reader `RoleArn` | The selected External Secrets ServiceAccount; align SecretStore references |
| ALB `LoadBalancerArn`, `ListenerArn` | `infrastructure.aws.alb.endpoints.<name>` in existing mode |
| HTTP `TargetGroupArn` | `infrastructure.aws.alb.bindings.<service>.targetGroupArn`, with actual Service name/port |
| NLB `TargetGroupArn`, `SecurityGroupId` | `bootnodePublicP2p[].existingNlb.targetGroupArn/securityGroupIds` |
| dstack listener/TG/private URL | `capacityManager.connection`: `mode: existing-alb`, `serverUrl`, and `existingAlb.{loadBalancerArn,listenerArn,targetGroupArn}` |
| Existing bucket name, region, prefix | `ethereumDa.blobArchive.s3` / `proofArtifacts.s3` |

Run the stages in order: `setup plan`, `setup aws`, `setup genesis`, then the
funding and runtime stages. Existing KMS keys use `action: reuse`; archive uses
`action: configure`; proof AWS uses `action: reuse` and an existing delivery mode.
Initialize the proof token Secret contents before installing workloads, as a
separate operator action recorded in the environment repository. Token values
never enter templates, parameters, arguments or logs. Metadata discovery does
not read or validate secret contents.

## ESO reader access

Both reader templates grant only `secretsmanager:GetSecretValue` and
`secretsmanager:DescribeSecret` under `SecretPrefix` in the selected account and
`SecretRegion`. Set the CLI Secret upload prefix and explicit Secret names to
match this deployment path, including `preparation.proofAws.secretName`.
For example, `SecretPrefix=dogeos/testnet/deployment-a` covers
`dogeos/testnet/deployment-a/database` and
`dogeos/testnet/deployment-a/proof-coordinator`.

Use `secrets-reader-policy.yaml` to attach this grant to an existing ESO role,
or `secrets-reader-role.yaml` to create a deployment-scoped IRSA role with trust
restricted to the selected issuer, namespace, ServiceAccount and audience.
The policy template preserves the existing role's trust and other grants.
Install ESO and bind its reader ServiceAccount separately. The templates do not
create Secret values or Kubernetes resources. Upload and rotation use a separate
operator identity; the reader has no AWS Secret write, delete or tagging grant.

`SecretEncryptionKeyArn` is optional and defaults to empty. Set it when the
Secrets use a customer-managed symmetric KMS key. The template grants only
`kms:Decrypt` on that key, through Secrets Manager in `SecretRegion`, with the
encryption context restricted to the deployment's Secret prefix. The key policy
must also allow access. This parameter selects a Secret encryption key, not a
blockchain signing key.

The optional `roles.externalSecrets` resolves the selected role ARN only.
Install and bind the operator ServiceAccount separately. The CLI does not
simulate IAM permissions or audit trust, bucket policy, network routing or
certificate coverage. Infrastructure operators own those validations; runtime
web-identity sessions and application access require later deployment tests.

For disposable tests, set `ResourceClassification=nonproduction-deletable`,
use a stable environment name containing `nonprod-deletable`, and apply the same
classification to stack tags. Aliases, descriptions and resource tags then make
the lifecycle explicit. Keys/aliases and Secret metadata still use Retain:
teardown must inventory and explicitly remove retained resources when approved.
Disable LB deletion protection in a reviewed stack update before deleting it.

## Local validation

```bash
python3 -m venv /tmp/dogeos-infra-checks
/tmp/dogeos-infra-checks/bin/pip install -r requirements-dev.txt
/tmp/dogeos-infra-checks/bin/cfn-lint ./*.yaml
/tmp/dogeos-infra-checks/bin/python -m unittest discover -s tests -v
```

The parameter checker rejects untouched placeholders, missing/unknown parameters,
invalid CIDRs, violated template rules, and inconsistent local edge settings.
It does not query AWS or prove existing resource ownership, AZs, permissions or
certificate coverage. Tests exercise the sensitive defaults and policy/routing
boundaries offline. There are no real account IDs, resource IDs or secrets in
the examples. These files are source-checkout tooling, not currently included in
the CLI npm package.

References: [CloudFormation best practices](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/best-practices.html),
[change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html),
[resource import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/import-resources-manually.html),
[stack outputs](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/outputs-section-structure.html).
