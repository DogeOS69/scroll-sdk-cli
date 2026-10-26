# Prepare AWS resources before genesis

These CloudFormation templates prepare infrastructure independently of Scroll SDK
genesis, Bridge funding, configuration rendering and Helm installation. Operators
review a change set and explicitly execute it. There is no deploy-all script.

The staged CLI consumes these outputs through explicit spec references. `setup aws`
reads existing AWS resource metadata before genesis and records bindings locally;
it does not create resources, adopt roles or update policies. Keep CloudFormation
as the owner. The output JSON below is a handoff artifact, not a `--resources`
CLI input; `setup import-aws` imports its references into the operator spec.

## Template organization by lifecycle

Use `stacks/` for a **new** environment. These are ordinary, self-contained
CloudFormation templates, generated offline from the small components alongside
this README. They require no nested-stack S3 publication and no extra deployment
engine. `assemble-stacks.py` never calls AWS.

| Lifecycle template | Ownership and update frequency |
| --- | --- |
| `stacks/signing-identities.yaml` | All five durable KMS identities and aliases; each identity defaults to reuse and has its own explicit create/reuse input; keys and aliases are retained on deletion |
| `stacks/workload-access.yaml` | Application permissions, roles and Pod Identity associations; update when permissions or ServiceAccount bindings change |
| `stacks/capacity-access.yaml` | Optional dstack permissions and association; no GPU allocation |
| `stacks/public-network.yaml` | Public HTTPS ALB and one bootnode NLB; existing VPC, subnets, certificate and EIPs are supplied |
| `stacks/capacity-network.yaml` | Optional internal HTTPS ALB and controller target; listener reference is wired inside the template |
| `stacks/secret-metadata.yaml` | Retained proof Secret metadata only; secret initialization/rotation is a separate operator action |
| `stacks/cluster-pod-identity.yaml` | Agent add-on owned once per cluster, shared by deployments |

Keep application HTTP targets/routes (`http-target.yaml`, `http-route.yaml`),
backend access rules and shared ESO reader grants under their actual owners.
Separate stacks for these are useful when the target application or platform has
an independent lifecycle. Repeated peer allowlist edits belong to the network
owner's reviewed change set; password rotation belongs to the secret owner and
the affected service, not to re-creating infrastructure or signing identities.

Regenerate and check the lifecycle templates after editing a component:

```bash
python infrastructure/aws/cloudformation/assemble-stacks.py
python infrastructure/aws/cloudformation/assemble-stacks.py --check
cfn-lint infrastructure/aws/cloudformation/stacks/*.yaml
```

Parameter names in composed templates carry the component prefix (for example
`EthDaMode`, `EthDaExistingKeyArn`, `EthDaAliasName`, `HttpsVpcId`). Shared
`Environment` and `ResourceClassification` are entered once. Use the matching `stacks/parameters/*.example.json` as the input skeleton;
placeholders must be replaced before validation. Listener and VPC references
within a network stack are connected automatically. Both the component and assembled templates use the
same `validate_parameters.py` and change-set workflow below.

**Existing stacks stay with their existing resources.** Do not deploy the
assembled stacks over resources already owned by component stacks. Prefixes are
CloudFormation logical IDs; changing them is not a harmless file reorganization.
Consolidating existing ownership requires a separate reviewed resource import or
refactor. Keeping the existing layout is supported and avoids replacing keys,
roles or load balancers just to reduce the stack count.

## Ownership and scope

Use a stable infrastructure environment name, such as `dogeos-testnet`. Changing
an application release, rehearsal date or local deployment directory must not
create a new infrastructure stack. A new chain identity requires a deliberate
decision about which keys and resources to reuse.

| Template | Resources created when explicitly deployed | Existing inputs |
| --- | --- | --- |
| `signing-key.yaml` | In `create` mode: one signing KMS key and alias. Default `reuse` mode creates neither. | Existing key ARN in reuse mode |
| `application-roles.yaml` | Six application roles and Pod Identity associations (optional IRSA); fixed two-sequencer example | Five signing key ARNs, two bucket names/prefixes, EKS cluster |
| `pod-identity-agent.yaml` | One cluster-level EKS Pod Identity Agent add-on | Existing cluster and explicitly selected compatible add-on version |
| `pod-identity-probe.yaml` | One disposable test role and Pod Identity association; KMS signing and prefix-scoped S3 listing only | Existing nonproduction signing key, bucket/prefix, cluster, test namespace/ServiceAccount names |
| `secrets-reader-policy.yaml` | One deployment-scoped read policy attached to an existing ESO role; preserves trust/other grants | Existing role name, Secret prefix, optional exact additional Secret ARNs and encryption key |
| `secrets-reader-role.yaml` | One deployment-scoped External Secrets IRSA reader role | Secret prefix/region, OIDC provider, optional exact additional Secret ARNs and encryption key |
| `dstack-role.yaml` | One dstack controller role; **zero GPU instances** | EKS cluster, VPC, two or three eligible private worker subnets, optional worker instance profile/role |
| `https-alb.yaml` | One ALB, one HTTPS listener, one SG, optional client ingress rule; optionally one exact-host private DNS zone and alias | VPC, two or three subnets, ACM certificate |
| `http-target.yaml` | One HTTP/IP target group and one host/path forwarding rule; **zero ALBs** | ALB listener, VPC, hostname, application port/health settings |
| `proof-secret.yaml` | Empty Secrets Manager Secret metadata, retained on deletion | Environment and Secret prefix |
| `http-route.yaml` | Additional host/path rule to an existing target group | Listener and target-group ARN |
| `backend-access.yaml` | Explicit backend SG ingress and optional LB SG egress | Actual node/Pod SG, LB SG, actual Pod port range |
| `bootnode-nlb.yaml` | One NLB, TCP listener, TCP/IP target group, SG and optional peer rule; **zero EIPs** | VPC, two public subnets, two unused EIP allocations |

Buckets are always supplied by the operator. `render-artifact-policy.py` emits a
complete policy template from a saved existing policy, preserving all other
statements and adding the selected prefix's HTTPS read grant. Review and deploy
that template in the bucket region using the current infrastructure owner. It never changes public-access-block settings
or retention. Do not give two stacks ownership of the same bucket policy.
They also do not create EKS, VPCs, NAT gateways, databases, certificates, OIDC
providers, Secret values, application Kubernetes objects, or GPU workers. The
optional Pod Identity Agent add-on runs a DaemonSet on existing cluster nodes.
The other dependencies are existing
platform resources or belong to later runtime stages. A dstack fleet is managed
by dstack, not represented as a static EC2 instance in this pack.

For the current two-sequencer topology, the five signing identities are ETH DA,
Fee Oracle, L2 sequencer 0, L2 sequencer 1, and the Dogecoin Bridge sequencer used
by Withdrawal Processor. P2P nodekeys and CubeSigner keys are not these KMS keys.
The optional Secrets Manager encryption key is a separate symmetric key.

Reuse existing resource references directly; deploying a wrapper reuse stack is
optional. Do not recreate existing keys or load balancers to adopt this pack.
To transfer ownership of existing resources, perform a separate reviewed
CloudFormation import where supported. Referencing an ARN is not importing it.
Never have the CLI, Terraform, CloudFormation and a Kubernetes Ingress controller
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

## Bounded compatibility rehearsal

The probe template is an optional disposable test, separate from formal workload
associations. Run the same bounded checks with formal ServiceAccounts to verify a
migration, without changing chain state or secrets.

1. Confirm the workloads run on supported EKS Linux EC2 nodes. Select an Agent
   version using `aws eks describe-addon-versions` for the cluster version;
   the example version is not a universal default. If the Agent already exists
   or EKS Auto Mode provides it, reuse it instead of creating another owner.
   Nodes need `eks-auth:AssumeRoleForPodIdentity` and connectivity to EKS Auth.
2. Review and execute `pod-identity-agent.yaml` once per cluster if needed.
   It uses `ResolveConflicts: NONE` and does not modify node IAM policies.
3. Review and execute `pod-identity-probe.yaml` with a disposable namespace and
   ServiceAccount name, an existing nonproduction KMS signing key, and an existing
   S3 prefix. It creates no KMS keys or buckets and permits no S3 writes. The role
   trusts only the specified cluster ARN, namespace and ServiceAccount session tags.
4. Create that ServiceAccount **without** `eks.amazonaws.com/role-arn`, and run
   temporary bounded Pods with no static credentials, no host network and
   `AWS_EC2_METADATA_DISABLED=true`. Do not print credential endpoint responses
   or projected tokens. Check the caller identity equals the probe role, KMS
   public-key lookup/signing works on a clearly non-transactional test message,
   and S3 listing succeeds only under the configured prefix. Verify another key
   and another prefix are denied, and an unassociated ServiceAccount has no
   credentials. Test each relevant node, not just one Agent instance.
5. Test a digest-pinned real service image as well. Use isolated configuration,
   existing public fixture artifacts and ephemeral storage. Disable writers and
   point chain RPCs at localhost so credential initialization cannot broadcast a
   transaction. A successful AWS CLI probe alone does not prove application SDK
   compatibility. Record the exact boundary reached by the application.
6. Delete the temporary Pods, ConfigMaps and ServiceAccounts, then the probe
   stack. Retain the cluster Agent only if it will be used; its separate stack
   is the explicit owner. Never delete existing keys, buckets or shared IRSA roles
   when removing this probe.

References: [AWS Agent setup](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-agent-setup.html),
[trust policy conditions](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html),
[SDK credential chain](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-minimum-sdk.html).

## Prepare inputs

Keep actual parameter files, stack outputs and environment records in a private
operator directory outside this public checkout. The files under `parameters/`
contain nonfunctional placeholders. They are not deployable environment files.

For a new environment, copy the required `stacks/parameters/*.example.json`
files into that private directory and edit those copies. Shared templates do not
need environment-specific edits. For example, a private `signing-identities.json`
can set `Environment=dogeos-testnet-cluster` and use these aliases:

| Parameter | Example value |
| --- | --- |
| `EthDaAliasName` | `alias/testnet/dogeos-testnet-cluster/eth-da-submitter` |
| `FeeOracleAliasName` | `alias/testnet/dogeos-testnet-cluster/fee-oracle` |
| `Sequencer0AliasName` | `alias/testnet/dogeos-testnet-cluster/sequencer-0` |
| `Sequencer1AliasName` | `alias/testnet/dogeos-testnet-cluster/sequencer-1` |
| `BridgeAliasName` | `alias/testnet/dogeos-testnet-cluster/bridge-sequencer` |

Aliases are operator-selected; `alias/dogeos/` in the skeleton is only an
example. Include the `alias/` prefix in parameter files (the KMS console omits
it when displaying names). Names must be unique within the AWS account and
region; `alias/aws/` is reserved. See the
[AWS alias naming rules](https://docs.aws.amazon.com/kms/latest/APIReference/API_CreateAlias.html).
To create all five identities, set all five `*Mode` parameters to `create` and
all five `*ExistingKeyArn` parameters to the empty string. To reuse an identity,
set its mode to `reuse` and supply its existing key ARN; its alias parameter is
ignored. Create mode does not adopt an existing alias automatically. Reapply
changes to the same environment's stack instead of creating another stack for
each deployment. `Environment` is a separate stable identifier (letters,
digits and hyphens), not the slash-separated alias path.

1. Select the AWS account/profile and region, existing EKS cluster and namespace.
   Use Pod Identity for application and dstack roles. ServiceAccount names must
   match the rendered Helm releases. For shared ESO or explicit legacy IRSA,
   read the OIDC issuer, supply it **without `https://`**, and use the existing
   IAM OIDC provider.
2. Select stable signing key ARNs. Verify `ECC_SECG_P256K1`, `SIGN_VERIFY`, enabled
   status, public keys and expected addresses. These templates use same-account
   role/key access; existing key policies must permit the selected roles or
   account IAM delegation. An IAM role policy alone cannot override a key policy.
3. Select archive/proof buckets and nonempty prefixes. Existing bucket policies,
   public-read/provider access and any SSE-KMS encryption permissions remain the
   bucket owner's responsibility. IAM grants here do not make artifacts publicly
   downloadable. DA's role can also read/write the two proof segmentation sidecar
   namespaces, matching the CLI contract. Coordinator may list/delete its proof
   prefix; WP cannot list/delete it.
4. Set a stable Secret prefix. Put new proof token Secrets under that prefix too
   (the CLI's `preparation.proofAws.secretName` can select the name). Existing Secrets
   outside it can use `AdditionalSecretArns`; see [ESO reader access](#eso-reader-access-and-migration).
   Align SecretStores and remote references. The reader cannot create/upload
   secrets or list all account Secrets. A different operator identity uploads
   contents later. Preserve an existing role with `secrets-reader-policy.yaml`, or
   explicitly bind a new deployment-scoped role from `secrets-reader-role.yaml`.
   Adding a narrow grant does not remove an existing broad grant. The managed
   policy has a lifecycle description and stack
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
Create a signing-key stack per new identity only when needed; five existing keys
need no key creation. Keys and aliases use `Retain` on deletion/replacement:
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
cluster, set the optional `SubnetC` (`HttpsSubnetC` in lifecycle stacks) as well
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
Initialize the proof token Secret externally before installing workloads:

```bash
python3 initialize-proof-secret.py --region "$AWS_REGION" --secret-id YOUR_SECRET_NAME
```

This creates the two token properties only when no version exists. A retry
preserves existing versions without reading credentials. A private temporary
file (RAM-backed when `/dev/shm` is available) carries the input and is removed
on exit; token values never enter arguments or output. Metadata discovery does
not read or validate secret contents.

## ESO reader access and migration

Keep the AWS reader separate from operator upload, rotation and infrastructure
administration. Both reader templates grant only `GetSecretValue` and
`DescribeSecret` for the deployment prefix and any explicitly selected Secret
ARNs. They grant no Secret writes, deletion, tagging or account-wide discovery.
ESO still needs Kubernetes permissions to create/update the destination Secrets.
Select extra read APIs only if the installed ESO version and enabled features
require them; these templates target explicit `remoteRef.key` reads, not
`dataFrom.find`, batch discovery or `PushSecret`.

Use `secrets-reader-policy.yaml` when the existing ESO IAM role and its IRSA trust
should remain. Use `secrets-reader-role.yaml` for a new deployment-scoped IRSA
identity; its trust is restricted to the selected issuer, namespace, ServiceAccount
and audience. Application Pod Identity does not require migrating this ESO identity.
Neither template creates an ESO installation, ServiceAccount, SecretStore or
Secret value. If the role and Kubernetes bindings are unchanged, this IAM change
needs no application chart or production-values change.

`SecretPrefix` is required and grants reads below that deployment path. For a
legacy proof Secret or another explicitly approved exception, set
`AdditionalSecretArns` to comma-separated **full ARNs**, including the six-character
Secrets Manager suffix, with no spaces or wildcards. The default is empty. Do not
broaden the prefix to a shared environment root merely to include one exception.
See `parameters/secrets-reader-policy.legacy-secret.example.json`. Renaming or
recreating an exact-ARN Secret requires reviewing this input again. Multiple
Secrets in one JSON object share the same AWS authorization boundary; selecting
a JSON property in an ExternalSecret does not isolate IAM access to that property.

`SecretEncryptionKeyArn` is optional. For a customer-managed symmetric encryption
key, both templates allow only `kms:Decrypt` on that key, through Secrets Manager
in `SecretRegion`, with the encryption context restricted to the same prefix or
exact additional ARNs. All selected Secrets using that grant must use that key
and region; other encryption keys require separately reviewed grants. The key
policy must also allow access. Do not supply a blockchain signing key here.

### Migrate an existing broad reader policy

This is an attachment migration, not a Secret recreation or password rotation.
Review the existing role, every SecretStore/ExternalSecret reference, encryption
keys, inline policies, managed policies and their infrastructure owners first.
Scope a reader role to one deployment or another explicitly shared trust boundary.

1. Inventory consumers of the old managed policy with
   `aws iam list-entities-for-policy --policy-arn "$OLD_POLICY_ARN"`. A policy may
   be shared by several environments. Save its document and the selected role's
   attachments outside the public checkout for recovery.
2. Prepare a separate `secrets-reader-policy.yaml` stack for the selected role,
   including any legacy exact-ARN exceptions. Follow the offline validation and
   reviewed change-set workflow above. Keep the existing role and trust.
3. Apply the scoped grant. It is **additive**: IAM permissions remain broad while
   the old policy is attached. A successful sync at this point does not prove
   least privilege.
4. Remove the old broad attachment from **only the selected role** through its
   existing owner. If CloudFormation manages it, update that stack's attachment;
   for an unmanaged attachment, explicitly detach the reviewed policy ARN from
   that role. Remove equivalent broad inline grants through their owners too.
   Do not edit or delete a shared policy as a shortcut, and do not remove other
   environments' attachments. These reader templates do not revoke grants owned
   by another stack or operator.
5. Verify the effective policy scope and observe a new ESO reconciliation after
   the cutover: `refreshTime` advances, all affected ExternalSecrets stay Ready,
   and no access-denied errors appear. A previously recorded Ready condition is
   not sufficient. Check only status/metadata; do not print secret contents.
6. Migrate other readers independently. Retire the old managed policy only after
   confirming it has no remaining consumers and no owning stack needs it.

If synchronization fails, correct the missing exact resource/key grant or restore
the saved attachment for the selected role through its owner, then recheck fresh
sync status. Existing Kubernetes Secrets alone do not demonstrate recovery.
Changes to Secret contents and service passwords remain separate operations.

Protect the Kubernetes side too: restrict changes to SecretStore/ExternalSecret,
the referenced ServiceAccount, ESO Pod exec access and ServiceAccount token
creation. Prefer namespaced stores for deployment boundaries. Namespace scoping
does not compensate for account-wide AWS access.

References: [AWS scoped read policies](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html),
[ESO AWS permissions](https://external-secrets.io/latest/provider/aws-secrets-manager/),
[ESO security practices](https://external-secrets.io/latest/guides/security-best-practices/).

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

## Existing bucket policy handoff

Save the current bucket policy outside this checkout, then render a proposal:

```bash
python3 render-artifact-policy.py --existing-policy "$INFRA_DIR/bucket-policy.json" \
  --bucket YOUR_EXISTING_BUCKET --prefix YOUR_LITERAL_PREFIX --kind proof \
  --output "$INFRA_DIR/proof-policy.template.json"
```

Use `--kind archive` for the archive prefix. CloudFormation CREATE rejects an
already-present bucket policy. If it has an existing IaC owner, update that owner.
For an operator-managed policy, apply the reviewed template explicitly:

```bash
python3 apply-artifact-policy.py --region YOUR_BUCKET_REGION \
  --template "$INFRA_DIR/proof-policy.template.json" \
  --before "$INFRA_DIR/bucket-policy.json"
```

The script rejects a changed prior snapshot, preserves all prior statements,
performs one PutBucketPolicy and compares the readback. Repeating the same
proposal is a no-op. S3 has no policy compare-and-swap, so serialize other policy
administration for this interval. No public-access-block setting is changed.
 Fetch the current policy again
immediately before applying and regenerate if it changed. The resulting stack
owns the complete policy, not an individual statement; use the existing IaC
owner when one already exists. Removing this stack retains the policy. For
cleanup, remove only the grant added by this environment through its owner.

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
