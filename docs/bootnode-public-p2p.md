# Reth bootnode public P2P access

`setup l2-bootnode-reth` prepares node identities. To let external RPC nodes
connect to those bootnodes, also run `setup bootnode-public-p2p` after
`setup prep-charts` has produced the indexed bootnode values.

```text
setup l2-bootnode-reth
  → setup prep-charts
  → setup bootnode-public-p2p
  → upload required Secrets and deploy the bootnode Helm releases
  → wait for public LoadBalancer endpoints
  → setup gen-rpc-package
  → start and verify the external RPC node
```

The supported provider is AWS. GCP is listed for compatibility but fails with
an explicit not-implemented error. P2P uses Kubernetes LoadBalancer Services;
it is separate from HTTP ingress and `setup tls`.

## Prepare the values

From the deployment directory, with AWS credentials for the intended cluster:

```bash
scrollsdk setup bootnode-public-p2p \
  --provider aws \
  --cluster-name YOUR_EKS_CLUSTER \
  --region YOUR_AWS_REGION \
  --namespace YOUR_NAMESPACE \
  --doge-config .data/doge-config.toml \
  --values-dir ./values \
  -N --json
```

The command reads `bootnodeReth.instances` and updates only
`values/l2-reth-bootnode-production-<index>.yaml` for those indices, including
non-contiguous indices. Missing or invalid values fail before provider calls.
Nodekeys, internal enodes and unrelated services are preserved.

By default it configures the EKS OIDC association, controller IAM service
account and AWS Load Balancer Controller. `--controller-chart-version` selects
a particular Helm release; otherwise it resolves the available chart once and
uses that exact version for installation. The IAM policy comes from the
matching controller `appVersion` and uses a versioned policy name. Existing
controllers with operator-managed IAM can be reused with
`--skip-controller-setup`; the command still checks readiness in the selected
cluster. The controller must support the TCP/UDP listener annotation below.

All Helm/kubectl operations inside this command use a temporary kubeconfig
generated for `--cluster-name` and `--region`, with its server checked against
the EKS endpoint. The operator's existing kubeconfig is not changed. Logs go to
stderr in JSON mode; stdout contains one result with `deployed: false` and the
updated file list.

The generated extra Service has two P2P ports (TCP and UDP, normally 30303),
`type: LoadBalancer`, internet-facing AWS controller ownership and IP targets.
It sets `aws-load-balancer-type: external` and
`aws-load-balancer-enable-tcp-udp-listener: "true"` as specified by the
[AWS controller Service annotation reference](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/).
The public Service does not expose the RPC or metrics ports.

Existing legacy `aws-load-balancer-type: nlb` or internal-LB annotations require
an explicit Service migration before this command proceeds. Inspect whether the
Service has already been deployed and plan its replacement; changing controller
ownership on a live Service is not an in-place migration. If the values have
never been deployed, remove the obsolete annotation and rerun. Custom annotations
and existing valid LB names are preserved. Generated names respect AWS's
32-character limit.

## Deploy and export public peers

Upload the Reth Secrets and apply the reviewed indexed values through the
deployment's bootnode Helm releases in the selected namespace. This command
does not install those releases, allocate Elastic IPs, or wait for their NLBs.
Running `prep-charts` again preserves the public P2P configuration.

After rollout, select the same cluster for the following commands and inspect
each configured bootnode's Service, for example index 0:

```bash
kubectl --context YOUR_CONTEXT -n YOUR_NAMESPACE \
  get service l2-reth-bootnode-0-p2p -o yaml
```

Once `.status.loadBalancer.ingress` contains usable endpoints, select that
cluster in the kubeconfig used by `gen-rpc-package` and run:

```bash
scrollsdk setup gen-rpc-package \
  --dogeos-rpc-package-dir /path/to/dogeos-rpc-package \
  --namespace YOUR_NAMESPACE
```

Use an actual RPC-package checkout containing `docker-compose.yml` and its
scripts. The command reads Service endpoints and generates the external peer
list from the same bootnode identities. Current Reth chart arguments disable
automatic discovery; external nodes use these explicitly configured peers.
Configuration generation and Helm rendering do not establish public network
reachability: verify the deployed NLB targets and actual Reth peer connections
from the external node.

## Local validation

The supplemental rehearsal is recorded at
`/tmp/scrollsdk-bootnode-public-j4ndnFKy`. CLI subprocess tests use explicit
AWS/eksctl/Helm/kubectl/curl doubles, including injected IAM/OIDC/readiness and
cluster-mismatch failures. A separate real Helm render verifies the public
Service. A full `gen-rpc-package` invocation with repository Compose templates
verifies public peer projection from simulated LB status. No cloud resources
or live public connections were created by this rehearsal.
