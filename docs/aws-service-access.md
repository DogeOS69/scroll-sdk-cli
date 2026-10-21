# Service AWS permissions during staged preparation

New AWS `setup plan` workflows default to `preparation.awsAccess.mode: managed`.
The pinned SDK must include the `install-aws-identities` Makefile target. No
additional Helm chart or change to `external-secrets-lib` is required.
Plans saved by older CLI versions retain their original workflow. For resources
whose permissions remain operator-managed, explicitly select `mode: external`.
This does not change existing `proofAws.action: reuse` into a write operation.

## Operator inputs and lifecycle

Use the normal AWS credential chain on the operator host, for example an SSO
profile selected by `AWS_PROFILE`. No access keys belong in the spec. `setup aws`
uses the AWS CLI with that identity; it creates workload IAM identities, not
operator credentials. Select the same account/profile for identity provisioning,
resource preparation and uploads. The optional per-step `awsProfile` settings are
for operators who deliberately manage separate sessions.

The operator supplies the account, EKS cluster, namespace, bucket names/regions
and prefixes, signing backends, public-read choices and existing worker networks.
CLI-generated roles are not inputs that operators need to discover and copy.
For a managed AWS plan, the relevant fragment is:

```yaml
preparation:
  awsAccess:
    mode: managed
    # Shared by ESO within this deployment namespace, not used by business Pods:
    secretReaderServiceAccount: external-secrets
    # Optional, only when snapshots.s3 is configured:
    snapshot:
      action: create
      publicRead: true
      serviceAccount: snapshot-writer
  proofAws:
    action: create
    publicReadMode: direct-s3
  archive:
    action: create
    publicRead: true
  secretUpload:
    provider: aws
```

This is a fragment, not a complete deployment spec. `proofAws.action: create`
creates missing resources and reconciles the selected resources' permissions;
it can use an existing bucket. `archive.action` and `awsAccess.snapshot.action`
accept `configure` for an existing bucket. Creating resources and managing their
policies are distinct from uploading artifacts. Public access is an explicit
choice; `false` requires a usable S3 Gateway endpoint read path. The CLI reuses
the endpoint recorded by proof preparation when it is in the bucket's region.
Cross-region private read paths must be arranged separately.

1. `setup plan` freezes the intent and writes the public permission inventory to
   `.scrollsdk/aws-service-access.json`. It lists one shared reader, Secret names
   grouped by consumer, and runtime S3/KMS/dstack permission intent. It does not
   contact AWS for this inventory or copy cloud credentials.
2. After `setup genesis`, `setup aws` provisions declared identities/buckets,
   reconciles bucket policies and creates one shared reader role. It creates
   empty application Secret containers to obtain exact ARNs, and includes the
   existing combined proof-token Secret from `.data/proof-aws.json`. It does not
   read, copy or split the proof token values. The reader can read the union of
   selected deployment Secrets. Outputs are stored in `.data/aws-service-access.json`.
3. `setup render` binds service runtime identities and the shared reader, and
   emits `manifests/aws-secret-reader.yaml`. Standalone `prep-charts` preserves
   these bindings too. An optional snapshot writer has its own separate manifest
   at `manifests/snapshot-writer-serviceaccount.yaml`.
4. `setup upload-secrets` / `setup push-secrets` fills application Secret containers
   and preserves the prepared reader. A different upload prefix or region is
   rejected before upload. Debug output never prints an AWS secret-string command.
5. With ESO and its v1 CRDs installed and the namespace prepared, run
   `make install-aws-identities KUBE_CONTEXT=<context> NAMESPACE=<namespace>`.
   Normal service installation targets invoke this prerequisite when the reader
   manifest exists. It applies the manifest with a dedicated server-side field
   manager and never forces field conflicts. No separate Helm release is installed.
   Apply the snapshot manifest separately before running an upload Job.

`setup aws` does not install Helm releases or launch GPU workers. The operator's
AWS identity needs the relevant IAM, KMS, S3, Secrets Manager and metadata
permissions to perform the selected preparation; runtime roles do not receive
those provisioning privileges.

## Permission boundaries

| Identity | Allowed access | Excluded access |
|---|---|---|
| Proof coordinator runtime | Proof prefix Get/Put/Delete; prefix-restricted ListBucket | Other bucket prefixes; Secrets Manager |
| Withdrawal processor runtime | Proof prefix Get/Put; its Bridge KMS key when selected | S3 list/delete; worker-master Secret |
| DA runtime | DA prefix Get/Put; the two segmentation-sidecar prefixes in the proof store; its signing key when KMS is selected | Other proof objects, list/delete, unrelated signing keys |
| Fee oracle / each sequencer runtime | GetPublicKey/Sign on its prepared key when KMS is selected | Other service signing keys |
| Shared deployment Secret reader | GetSecretValue/DescribeSecret on the union of exact deployment Secret ARNs | Unselected Secrets; Secret writes/deletes/listing; runtime KMS signing, S3 and EC2 |
| Snapshot writer | PutObject and multipart abort/list-parts on the selected prefix | Bucket-wide list, object delete, other prefixes |
| dstack controller | EC2 operations for workers in selected regions/subnets, with project-tag conditions where supported | Other projects' instance termination; general PassRole; load balancer administration |

DA's role is created even with local signing. With KMS signing, its existing
runtime role receives the named S3 policy instead of creating a second runtime
identity. A separate snapshot identity is created for an operator-provided
Kubernetes upload Job; the Job must set `serviceAccountName`. The CLI does not
create snapshot contents, Jobs or a general host/deploy role.

The reader defaults to `external-secrets` in the deployment namespace. Set
`awsAccess.secretReaderServiceAccount` to use another name. Use a dedicated
namespace per deployment and keep production/test readers separate. Runtime Pods
continue using their runtime ServiceAccounts; ESO uses the shared reader through
`SecretStore.spec.provider.aws.auth.jwt.serviceAccountRef`. Service-specific
Secret mappings select what is synchronized; they are not IAM isolation between
services. Anyone able to use the reader credentials can read all selected Secrets,
including both properties in the combined proof-token object. Restrict changes to
ExternalSecrets, SecretStores, workloads and ServiceAccount token issuance to
trusted operators. The reader's token is not automatically mounted in business Pods.

Services without runtime AWS API calls need no empty runtime IAM role.
Capacity-manager consumes the coordinator's Kubernetes token Secret and dstack
API credentials; it does not inherit the controller's EC2 role.

For Secrets encrypted with a customer-managed key, specify the exact
`awsAccess.secretsKmsKeyArn`. Reader Decrypt grants are constrained to Secrets
Manager and the selected Secret ARNs in the encryption context. The key policy
must permit these IAM grants; this workflow does not take over an existing key
policy. Managed artifact buckets currently require SSE-S3; SSE-KMS artifact
stores use external permission management.

Bucket reconciliation retains other policy statements and manages the existing
CLI statement names, TLS-only access and versioning. It does not grant anonymous
list/write/delete. New reader and standalone runtime roles require matching
ownership tags when resumed; unrelated roles and extra policies are rejected.
There is no automated role/Secret deletion or IAM policy takeover.

## Existing deployments

The existing combined proof Secret remains authoritative. The shared reader gets
read access to that exact object; WP still synchronizes only `proof-work-token`
and the coordinator synchronizes both tokens. This is a mapping distinction,
not a per-property IAM boundary. No token migration or rotation is introduced.

For an existing deployment, retain its bucket/prefix, explicit `proofAws.secretName`,
keys, genesis, database and signer state. Use `configure` for existing DA/snapshot
buckets. **Do not run a new genesis workflow against an existing chain to migrate
IAM.** Prepare in an isolated directory and review/copy only the permission outputs
and final values. Review the existing reader ServiceAccount and its role before
applying the new manifest; resolve field ownership conflicts explicitly, or use
another reader name and switch the generated references. Managed preparation does
not adopt an unrelated IAM role. Select `awsAccess.mode: external` to retain a
manually managed reader and permission setup. Old saved plans are not rewritten.

If testing the earlier unmerged per-service reader implementation, regenerate
its plan and rendered outputs with this shared-reader version. Remove its obsolete
`values/aws-access-production.yaml` from the deployment workspace. If its chart
was installed, complete the reader cutover before uninstalling that chart or
retiring the unused roles; no automated deletion is performed.

The shared ServiceAccount and AWS resources are not deleted by service Helm
uninstalls or `delete-all`. Remove them only after their consumers have stopped.
Existing IAM policies, permission boundaries, SCPs, bucket/endpoint/key policies
and node IMDS access can affect effective access.

## Prerequisites and acceptance

EKS, its IAM OIDC provider, ESO with v1 CRDs and permission to request tokens for
the shared reader ServiceAccount, node IMDS restrictions, EBS CSI, VPC routing, optional
worker instance profiles, quotas, ACM/DNS and shared databases remain operator
infrastructure. NLB and ALB preparation stays manual. See
[AWS resource coverage](aws-resource-preparation.md) and
[dstack preparation](dstack-aws-preparation.md).

Offline tests cover the shared reader permission union, unchanged proof tokens,
container creation, local-signing DA access, snapshot creation, generated manifests
and installation ordering. They do not prove effective permissions in an AWS account. Before a
production rollout, verify each Pod's AWS identity and representative allowed
and denied operations, ESO synchronization, actual S3 reads/writes and a bounded
dstack launch/terminate canary. No live deployment is performed by these tests.

References: [AWS IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html),
[ESO AWS authentication](https://external-secrets.io/latest/provider/aws-secrets-manager/),
[EC2 action/resource support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html).
