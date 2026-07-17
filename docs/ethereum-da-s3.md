# Ethereum DA S3 Archive Reference

`eth-da-submitter` can archive submitted EIP-4844 blob bytes to S3, and
`l1-interface` / `withdrawal-processor` can later rehydrate those blobs through
an unauthenticated HTTP `aws_s3` blob source. This is useful after Beacon API
blob retention expires.

The CLI does not create S3 buckets or bucket policies. Configure the bucket,
public read path, and submitter write permissions before running
`scrollsdk setup prep-charts`. The CLI reads `.data/doge-config.toml` and writes
the corresponding Helm environment values.

The resolver performs one anonymous HTTP GET per blob:

```text
GET {publicBaseUrl}/{0x-versioned-hash}
```

The response body must be the raw EIP-4844 blob bytes. It is not JSON, and the
expected size is `131072` bytes.

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
timeoutMs = 15000
treatForbiddenAsMissing = false
```

`bucket` and `region` are used by `eth-da-submitter` for `PutObject`.
`publicBaseUrl` is used by `l1-interface` and `withdrawal-processor` for
anonymous HTTP reads. These values must point at the same object namespace.
Object keys are the `0x`-prefixed versioned hashes; there is no separate prefix
setting.

Grant the submitter's AWS identity, such as its IRSA role, write and read-back
access for conflict checks:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],
  "Resource": "arn:aws:s3:::dogeos-eth-da-archive-testnet/*"
}
```

If using direct public S3 reads, configure the bucket policy to allow anonymous
`s3:GetObject` on archive objects while keeping writes private:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadEthDaBlobArchive",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::dogeos-eth-da-archive-testnet/*"
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
timeoutMs = 15000
treatForbiddenAsMissing = false
```

The URL `https://da-archive.example.com/0xabc...` must return the object stored
at `s3://dogeos-eth-da-archive-testnet/0xabc...`.

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
| `enabled` | yes | submitter, l1-interface, withdrawal-processor | Enables S3 upload and readback when `true`. |
| `bucket` | yes when enabled | eth-da-submitter | Existing bucket name. The CLI does not create it. |
| `region` | yes when enabled | eth-da-submitter | Bucket region. Must match the real bucket region. |
| `publicBaseUrl` | yes when enabled | l1-interface, withdrawal-processor | Public HTTP base URL used for anonymous `GET {base}/{0x-versioned-hash}`. |
| `timeoutMs` | no | l1-interface, withdrawal-processor | HTTP GET timeout. `15000` is a reasonable starting point. |
| `treatForbiddenAsMissing` | no | l1-interface, withdrawal-processor | Keep `false` unless the endpoint intentionally uses 403 for absent objects. |
| `endpointUrl` | no | eth-da-submitter | Custom S3-compatible upload endpoint. Usually omitted for AWS S3. |
| `forcePathStyle` | no | eth-da-submitter | Set `true` for endpoints that require path-style URLs. |
| `pollIntervalMs`, `initialBackoffMs`, `maxBackoffMs`, `maxRetries`, `uploadingTimeoutMs` | no | eth-da-submitter | Upload retry and timeout tuning. Defaults are normally sufficient. |

## Verify the public URL

After `eth-da-submitter` uploads an object, verify the read URL from a network
that can reach `l1-interface` and `withdrawal-processor`:

```bash
curl -I "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/0x..."
curl -s "https://dogeos-eth-da-archive-testnet.s3.us-west-2.amazonaws.com/0x..." | wc -c
```

Expected results:

- existing object: HTTP `200`;
- existing object body size: `131072`;
- missing object: ideally HTTP `404`; some deny policies return `403`.

Keep `treatForbiddenAsMissing = false` first so ACL or public-read mistakes are
visible. Set it to `true` only after confirming that 403 is the intended
missing-object behavior.

Run `scrollsdk setup prep-charts` after updating `.data/doge-config.toml` to
sync S3 settings into `eth-da-submitter`, `l1-interface`, and
`withdrawal-processor` values.
