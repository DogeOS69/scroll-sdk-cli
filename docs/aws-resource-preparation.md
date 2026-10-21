# AWS resource preparation coverage

Source audit: 2026-10-21. Managed service access is described in [the implementation guide](aws-service-access.md). This inventories the CLI preparation paths and matching
SDK service prerequisites, not any deployed account. No live AWS readiness is
implied. Use a private deployment spec and keep real resource identifiers and
credentials out of source examples.

**NLBs and ALBs are prepared manually.** Existing-reference generation, read-only
preflight and Kubernetes target registration are supported; expanding their AWS
resource creation is not part of this work. Legacy optional ingress/network
creation paths still exist, but are not the recommended preparation route here.

## Service and resource inventory

| Consumer / resource | Existing preparation route | Operator handoff / remaining gap |
|---|---|---|
| L2 sequencer, fee oracle, eth-da-submitter: KMS signing keys, IAM role and IRSA | `setup aws` identities / `setup gen-keystore`; [keystore guide](keystore.md) | Choose KMS explicitly; supply account, EKS and service identity inputs. EKS/OIDC and the operator's provisioning access must exist. |
| Withdrawal processor: Bridge sequencer KMS key and signing grants | `preparation.bridge.production.sequencerKms` in `setup aws`; [spec workflow](spec-preparation.md#commands) | Create/reuse modes; role selection and imported key prerequisites remain explicit. This does not create a fee-wallet KMS signer. |
| Proof coordinator and withdrawal processor: artifact S3 bucket, workload roles, shared token Secret, optional S3 endpoint | `preparation.proofAws` / `setup proof-aws-init`; [proof runbook](proof-operator-runbook.md), [artifact storage](ethereum-da-s3.md) | Select external read mode. Reuse requires existing resources. Cross-region endpoints/gateway delivery and effective worker/signer read access need operator verification. |
| eth-da-submitter: DA archive bucket, writer role policy and public read policy | `preparation.archive` / `setup eth-da-submitter`; `setup artifact-access --store da`; [archive guide](ethereum-da-s3.md) | Managed setup creates a DA runtime role independently of the signing backend, or augments its existing KMS role. `configure` preserves the existing-bucket boundary; public read requires explicit selection. |
| Snapshot publication/bootstrap: S3 bucket and writer/public read policy | `preparation.awsAccess.snapshot` creates/configures the bucket and a dedicated Kubernetes writer; `setup artifact-access --store snapshot` checks existing access; [preflight guide](deployment-preflight.md) | Select create/configure and public read explicitly; bind upload Jobs to the generated snapshot ServiceAccount; this is not the proof bucket workflow. Source snapshot contents and publication are separate operator work. |
| Proof program and signer kit publication: S3 object prefixes/read policy | `setup proof-publish`, `setup signer-kit-publish`; [spec workflow](spec-preparation.md) | Reuses the proof store; publishing identity needs prefix-scoped access. Does not prepare ECR/image registries. |
| dstack controller / capacity-manager workers: EC2 provisioning role and IRSA | `preparation.dstack.aws.action` in `setup aws`; [new runbook](dstack-aws-preparation.md) | Automates create/reuse of the controller role and binding; reads existing networks. Worker profile, VPC egress, controller reachability and GPU quotas remain manual. Capacity-manager itself does not need the controller's EC2 role. |
| Runtime application Secrets: Secrets Manager records and Kubernetes references | `setup upload-secrets` / `setup push-secrets`; [spec workflow](spec-preparation.md) | Managed `setup aws` prepares one shared reader role with exact deployment Secret ARNs and emits its ServiceAccount manifest; uploads fill application containers and preserve bindings. Existing proof token objects are retained. **ESO installation remains a cluster prerequisite**. Dstack bundles and monitoring Secrets have their own direct Kubernetes upload path. |
| Stateful services: Reth, Dogecoin, Blockbook, bridge history, monitoring, optional SQLite dstack | Helm PVCs via SDK charts; `setup deployment-preflight` covers selected compute/manifest prerequisites, not storage topology | **EBS CSI identity/add-on, StorageClasses and optional snapshot controller are cluster prerequisites**, not provisioned by service setup. Verify AZ/topology, reclaim policy and backups. |
| Shared PostgreSQL: Blockscout, dstack and other database consumers | `setup db-init`; staged selections create databases/users in an existing PostgreSQL server | **No RDS instance, subnet group, database SG, backups or parameter-group creation.** Connection inputs do not prove server/network readiness. |
| Bootnode public P2P: NLB, EIP, SG, TCP listener/IP target group | Manual resource preparation; `setup nlb` validates; [NLB runbook](existing-nlb.md) links SDK creation/handoff instructions | Intentionally manual. Preserve per-node identity, approved partner CIDRs, AZ alignment and resource lifecycle outside Helm. |
| Public HTTP services: ALB, listener/rules, IP target groups and SGs | Manual resource preparation; `setup alb` validates; [ALB runbook](existing-alb.md) | Intentionally manual. AWS Load Balancer Controller and TargetGroupBinding CRD/permissions must already exist. |
| TLS and endpoint names: ACM certificates, DNS records/private zones | Domain/ingress projection and selected certificate checks; [ALB guidance](existing-alb.md), [spec TLS guidance](spec-preparation.md#internal-dstack-https-with-managed-certificate-renewal) | **No general certificate issuance/DNS setup workflow.** Operator creates/validates certificates, binds listeners and creates public/private records, including renewal validation records. |
| EKS shared foundation: VPC/subnets, cluster/node groups, OIDC, add-on roles | Input references and read preflight only; [deployment preflight](deployment-preflight.md) | **No complete cluster bootstrap runbook in the CLI.** Prepare before per-service IAM. The dstack guide now includes OIDC association and required worker route rules. |
| Optional AWS GPU quotas, billing alerts and service-linked roles | Existing Core AWS runbook linked from [dstack guide](dstack-controller.md) | Manual account operations. No quota-increase or budget/alert creation in the staged CLI. Check each selected region; quota submission is not approval. |
| CubeSigner-backed signer services | CubeSigner preparation/governance/session steps; [CubeSigner workflow](cubesigner-preparation.md) | CubeSigner organization/keys/policies are provider prerequisites, not AWS resources that this CLI creates in the operator account. Partner-host EC2/EBS/network setup, if selected, remains partner infrastructure. |

## Gaps worth addressing next

The service-level KMS and S3 paths have preparation commands. The main remaining
operator handoffs are cluster foundations and optional infrastructure:

1. A reusable EKS prerequisite runbook: OIDC provider, EBS CSI, External Secrets
   token-request RBAC and node IMDS isolation, and the Load Balancer Controller/CRD.
   The shared deployment reader IAM role and ServiceAccount manifest are now prepared by managed setup. Include
   role ownership and read-only acceptance checks, not automatic role takeover.
2. A shared PostgreSQL/RDS prerequisite runbook: engine/version, network reachability,
   TLS, admin bootstrap, backup and restore acceptance. `db-init` operates inside
   this server and must not be described as creating RDS.
3. Snapshot source sanitization, upload Job/host identity selection, publication
   and actual read acceptance. Managed setup now prepares the bucket and a Kubernetes writer.
4. A certificate/DNS handoff covering issued ACM certificates, listener attachment,
   public/private resolution and renewal validation. Keep NLB/ALB creation in the
   existing manual runbooks.

These remaining cluster/account operations are separate from the implemented
per-service IAM, Secrets Manager and artifact bucket preparation.
