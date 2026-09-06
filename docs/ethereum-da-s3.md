# Ethereum DA S3 Archive Reference

`eth-da-submitter` can archive submitted EIP-4844 blob bytes to S3, and
`l1-interface` / `withdrawal-processor` can later rehydrate those blobs through
an unauthenticated HTTP `aws_s3` blob source. This is useful after Beacon API
blob retention expires.

The canonical configuration lives in
`.data/doge-config.toml` under `[ethereumDa.blobArchive.s3]`. Configure it
directly when the bucket and IAM resources are managed separately, or use
`scrollsdk setup eth-da-submitter` to record the archive configuration while
configuring the submitter signer.

When the submitter uses an AWS KMS signer,
`scrollsdk setup eth-da-submitter` can create a missing AWS S3 bucket. Bucket
creation is enabled by default and can be disabled with
`--no-create-archive-bucket`. A bucket created by the CLI has all public access
blocked and SSE-S3 (`AES256`) enabled. The CLI does **not** create an anonymous
read bucket policy, CloudFront distribution, or other public read transport.
Operators must configure and verify the `publicBaseUrl` transport separately.

This is also the canonical object store for proof topology. dogeos-core does
not expose a second S3 client for segmentation sidecars: raw DA blobs and proof
artifacts use the same bucket, region, and key prefix, with different logical
object keys. `setup proof-aws-init` reads this table and refuses an independent
proof bucket/prefix.

For a prefix such as `rehearsal/batches`, the relevant namespaces are:

```text
rehearsal/batches/0x<versioned-hash>                         raw DA blob
rehearsal/batches/scroll-chunk-segmentation-sidecars/...    internal sidecar
rehearsal/batches/input-specs/...                           Worker input
rehearsal/batches/prepared-bundles/...                      Worker input
rehearsal/batches/witnesses/...                             Worker/signer input
rehearsal/batches/public-outputs/...                        Worker output
rehearsal/batches/proofs/...                                proof bytes
```

The bucket can still apply different read permissions to those object-key
patterns. In direct-S3 mode, never grant anonymous `GetObject` to the entire
`<keyPrefix>/*`: the segmentation-sidecar namespace is internal. List, write,
and delete remain authenticated even for externally readable objects.

After configuring the archive, run `scrollsdk setup prep-charts`. It reads
`.data/doge-config.toml` and projects the settings into `eth-da-submitter`,
`l1-interface`, `withdrawal-processor`, and every runtime Reth values file.
`scrollsdk setup gen-rpc-package` independently reads the same canonical
configuration when it generates `L2RETH_BLOB_S3_URL`.

The resolver performs one anonymous HTTP GET per blob:

```text
GET {publicBaseUrl}/{keyPrefix}/{0x-versioned-hash}
```

When `keyPrefix` is empty, the prefix path segment is omitted.
The response body must be the raw EIP-4844 blob bytes. It is not JSON, and the
expected size is `131072` bytes.

## Configure through the CLI

For an existing bucket whose public read path and IAM policy are managed by the
operator:

```bash
scrollsdk setup eth-da-submitter \
  --non-interactive \
  --json \
  --signer-backend aws-kms \
  --aws-region us-east-1 \
  --eks-cluster dogeos-devnet-cluster \
  --namespace default \
  --network-alias devnet \
  --archive-bucket dogeos-eth-da-archive-devnet \
  --archive-region us-west-2 \
  --archive-key-prefix devnet/eth-da/blobs/v1 \
  --archive-public-base-url https://dogeos-eth-da-archive-devnet.s3.us-west-2.amazonaws.com \
  --no-create-archive-bucket
```

`--aws-region` selects the KMS/EKS/IRSA and Secrets Manager region.
`--archive-region` selects the S3 bucket region; the two regions may differ.
An S3 Gateway endpoint is regional, so proof AWS setup does not associate an
EKS-region gateway endpoint when the shared artifact bucket is cross-region.

To let the CLI create a missing bucket, use
`--create-archive-bucket` (the default) instead. The CLI performs
`HeadBucket`, creates only on a not-found result, blocks all public access, and
enables SSE-S3. It grants `s3:GetObject` and `s3:PutObject` on
`arn:aws:s3:::<bucket>/*` when it creates or manages the submitter IAM role.
When an existing role ARN is supplied or reused, treat the role as
operator-managed and verify its S3 permissions independently.

The command writes the resolved values back to `.data/doge-config.toml`; it
does not directly update Helm values. Run:

```bash
scrollsdk setup prep-charts --non-interactive --json
```

afterward. Use `--disable-archive` only when the archive is intentionally
disabled; a later `prep-charts`/`gen-rpc-package` run will then remove managed
S3 read configuration.

## AWS S3 direct bucket

Create a dedicated bucket for one environment, for example:

```text
dogeos-eth-da-archive-testnet
```

Use the real bucket region and direct virtual-hosted S3 URL:

```toml
[ethereumDa.blobArchive.s3]
enabled = true
bucket = "dogeos-eth-da-archive-testnet"
region = "us-west-2"
publicBaseUrl = "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/"
keyPrefix = "testnet/eth-da/blobs/v1"
timeoutMs = 15000
treatForbiddenAsMissing = false
```

`bucket` and `region` are used by `eth-da-submitter` for `PutObject`.
`publicBaseUrl` is used by `l1-interface`, `withdrawal-processor`, and Reth blob
consumers for HTTP reads. `keyPrefix` is applied to both upload and read paths.
These values must point at the same object namespace. With the example above,
an object is stored and read as
`testnet/eth-da/blobs/v1/<0x-versioned-hash>`.

Grant the submitter's AWS identity, such as its IRSA role, write and read-back
access for conflict checks:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],
  "Resource": "arn:aws:s3:::dogeos-eth-da-archive-testnet/testnet/eth-da/blobs/v1/*"
}
```

If using direct public S3 reads, configure the bucket policy to allow anonymous
`s3:GetObject` on archive objects while keeping writes private. A bucket
created by the CLI has `BlockPublicPolicy=true`, so enabling direct anonymous
S3 reads also requires an explicit, security-reviewed Public Access Block
change. Prefer CloudFront or another authenticated/private-origin read
transport when public S3 access is not acceptable.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadEthDaBlobArchive",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::dogeos-eth-da-archive-testnet/testnet/eth-da/blobs/v1/*"
    }
  ]
}
```

## CloudFront or custom public read URL

You can keep the bucket private and expose reads through CloudFront or another
HTTP proxy. `bucket` and `region` still describe the S3 upload target, while
`publicBaseUrl` is the public read endpoint:

```toml
[ethereumDa.blobArchive.s3]
enabled = true
bucket = "dogeos-eth-da-archive-testnet"
region = "us-west-2"
publicBaseUrl = "https://da-archive.example.com/"
keyPrefix = "testnet/eth-da/blobs/v1"
timeoutMs = 15000
treatForbiddenAsMissing = false
```

The URL
`https://da-archive.example.com/testnet/eth-da/blobs/v1/0xabc...` must return
the object stored at
`s3://dogeos-eth-da-archive-testnet/testnet/eth-da/blobs/v1/0xabc...`.

## S3-compatible endpoints

For MinIO or another S3-compatible service, configure the upload endpoint and
path-style addressing when required:

```toml
[ethereumDa.blobArchive.s3]
enabled = true
bucket = "dogeos-da"
region = "us-east-1"
endpointUrl = "http://minio.default.svc.cluster.local:9000"
forcePathStyle = true
publicBaseUrl = "http://minio.default.svc.cluster.local:9000/dogeos-da"
timeoutMs = 15000
treatForbiddenAsMissing = false
```

The resolver requests
`http://minio.default.svc.cluster.local:9000/dogeos-da/0xabc...`.

## Field reference

| Field | Required | Used by | Description |
|---|---|---|---|
| `enabled` | yes | submitter, l1-interface, withdrawal-processor, Reth | Enables S3 upload and readback when `true`. |
| `bucket` | yes when enabled | eth-da-submitter | Bucket name. The AWS KMS signer setup path can create it unless `--no-create-archive-bucket` is set. |
| `region` | yes when enabled | eth-da-submitter | Bucket region. Must match the real bucket region. |
| `publicBaseUrl` | yes when enabled | l1-interface, withdrawal-processor, Reth | HTTP base URL used for `GET {base}/{keyPrefix}/{0x-versioned-hash}`. |
| `keyPrefix` | no | submitter and readers | Shared object-key prefix appended between the base URL/bucket and the versioned hash. |
| `timeoutMs` | no | l1-interface, withdrawal-processor | HTTP GET timeout. `15000` is a reasonable starting point. |
| `treatForbiddenAsMissing` | no | l1-interface, withdrawal-processor | Keep `false` unless the endpoint intentionally uses 403 for absent objects. |
| `endpointUrl` | no | eth-da-submitter | Custom S3-compatible upload endpoint. Usually omitted for AWS S3. |
| `forcePathStyle` | no | eth-da-submitter | Set `true` for endpoints that require path-style URLs. |
| `pollIntervalMs`, `initialBackoffMs`, `maxBackoffMs`, `maxRetries`, `uploadingTimeoutMs` | no | eth-da-submitter | Upload retry and timeout tuning. Defaults are normally sufficient. |

## Verify the public URL

After `eth-da-submitter` uploads an object, verify the read URL from a network
that can reach `l1-interface` and `withdrawal-processor`:

```bash
curl -I "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/testnet/eth-da/blobs/v1/0x..."
curl -s "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/testnet/eth-da/blobs/v1/0x..." | wc -c
```

Expected results:

- existing object: HTTP `200`;
- existing object body size: `131072`;
- missing object: ideally HTTP `404`; some deny policies return `403`.

Keep `treatForbiddenAsMissing = false` first so ACL or public-read mistakes are
visible. Set it to `true` only after confirming that 403 is the intended
missing-object behavior.

Run `scrollsdk setup prep-charts` after updating `.data/doge-config.toml` to
sync S3 settings into `eth-da-submitter`, `l1-interface`,
`withdrawal-processor`, and runtime Reth values. Run
`scrollsdk setup gen-rpc-package` after that when producing an external RPC
package.

Proof setup with `--artifact-public-read-mode existing-gateway` does not
modify the shared bucket policy or its Public Access Block settings. Those
controls may already be serving raw DA consumers and remain the operator's
responsibility. Use `direct-s3` only when scroll-sdk-cli is meant to own the
narrowly scoped anonymous-read statement.
