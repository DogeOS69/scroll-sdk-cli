# Shared public ALB configuration

Use `infrastructure.aws.sharedAlb` to opt selected public services into one
controller-managed ALB. It can coexist with `infrastructure.aws.alb` external
bindings for TSO and Proof Coordinator. A service cannot belong to both modes;
TSO and Proof Coordinator cannot join the shared group.

Add the following to a complete deployment spec (all identifiers below are
nonfunctional examples):

```yaml
infrastructure:
  provider: aws
  aws:
    accountId: "000000000000"
    region: us-east-1
    eksClusterName: example
    sharedAlb:
      groupName: public-example
      certificateArn: arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000
      services:
        - l2-reth-rpc-public
        - frontends
        - blockscout-api
        - blockscout-frontend
frontend:
  hosts:
    rpcGateway: rpc.example.com
    frontend: portal.example.com
    blockscout: explorer.example.com
```

Use the actual spec's RPC host field (`rpcGateway`) and, when needed, include
`l2-reth-rpc-public-ws` with a distinct `frontend.hosts.rpcGatewayWs` WebSocket host. Both
Blockscout components must be selected together. Omitted `sharedAlb` retains
existing behavior; this feature does not implicitly expose other services.

`setup generate-from-spec` merges the committed SDK templates and operator
values, then applies the explicit selection. `setup prep-charts` reapplies it
before certificate checks and before publishing prepared values. Selected
Ingresses become enabled with one certificate/group, HTTPS 443, IP targets,
TLS policy, service health checks and API-before-frontend order. Unselected
Ingresses are not automatically disabled: final AWS preparation requires an
explicit external binding/shared selection or a disabled HTTP ingress for the
ALB-managed application files.

Blockscout omits generated `paths` so the chart retains `/socket`, API/auth and
frontend catch-all routes. Operator-provided Blockscout path overrides are
preserved and replace the entire chart list. The chart default also exposes
`/public-metrics`. The NGINX-specific extra metrics Ingress is disabled.
Frontend API/APP hosts come from enabled Ingresses, protocols become HTTPS/WSS,
and network/currency variables come from `config.network` to avoid duplicates.
Portal and RPC still need complete nested `hosts[].paths` lists. Regeneration
retains operator paths while refreshing the spec-owned primary hostname.

Use the paired SDK commit/release with Blockscout **0.1.12-dogeos** or later:
`--sdk-dir` reads committed templates, and `templates.sdkRevision`, if supplied,
must point to that compatible commit. The generated Makefile uses the paired
chart pin; publish that chart to OCI before installation. Generation and planning
do not provision the shared ALB, request ACM certificates, modify DNS, or test
live database credentials.

The AWS operator supplies the controller, permissions/subnets, certificate and
reachability. The Cloudflare operator supplies ACM validation and a wildcard
DNS-only CNAME to the resulting ALB. Hosts inside that DNS/certificate coverage
and paths are subsequently managed by the application Helm releases. Keep
IngressGroup membership limited to trusted releases. Follow the SDK's
[shared ALB guide](https://github.com/dogeos69/scroll-sdk/blob/main/examples/shared-alb.md)
for manual production values and acceptance checks.

`setup aws` continues to verify **external** ALBs and their bindings; it does not
claim to verify the controller-created shared ALB. Confirm shared listener,
certificate and target health after installation, along with RPC POST, Portal
pages and Blockscout APIs/WebSocket/indexing. The RPC GET health matcher
`200-499` proves reachability only.
