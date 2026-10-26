#!/usr/bin/env python3
"""Apply a reviewed complete policy to an existing bucket, preserving its previous policy.

CloudFormation cannot CREATE an existing bucket policy. Use the existing IaC
owner when available; otherwise this explicit infrastructure action consumes the
reviewed template and a snapshot of the prior policy. No buckets are created.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def canonical(value):
    # IAM accepts a scalar or a singleton list for Action, Resource and conditions;
    # S3 normalizes these forms when returning a policy.
    if isinstance(value, list):
        items = [canonical(item) for item in value]
        return items[0] if len(items) == 1 else items
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    return value


def apply(template, before, region, profile=None, run=subprocess.run):
    resource = template['Resources']['ArtifactPolicy']
    if resource['Type'] != 'AWS::S3::BucketPolicy':
        raise ValueError('Expected a complete bucket policy template')
    bucket = resource['Properties']['Bucket']
    desired = resource['Properties']['PolicyDocument']
    expected = json.loads(before['Policy']) if 'Policy' in before else before
    old = expected.get('Statement', [])
    old = [old] if isinstance(old, dict) else old
    if desired.get('Statement', [])[:len(old)] != old:
        raise ValueError('Proposed policy does not preserve existing statements')
    base = ['aws', '--region', region, '--no-cli-pager'] + (['--profile', profile] if profile else [])
    def call(args):
        result = run(base + args + ['--output', 'json'], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ValueError('Bucket policy request failed; provider details omitted')
        return json.loads(result.stdout) if result.stdout.strip() else {}
    current = json.loads(call(['s3api', 'get-bucket-policy', '--bucket', bucket])['Policy'])
    if canonical(current) == canonical(desired):
        return 'Policy already matches; no changes'
    if canonical(current) != canonical(expected):
        raise ValueError('Bucket policy changed since review; refresh the snapshot and proposal')
    call(['s3api', 'put-bucket-policy', '--bucket', bucket, '--policy', json.dumps(desired)])
    if canonical(json.loads(call(['s3api', 'get-bucket-policy', '--bucket', bucket])['Policy'])) != canonical(desired):
        raise ValueError('Policy readback differs; inspect concurrent infrastructure changes')
    return 'Policy applied and read back; previous statements preserved'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', type=Path, required=True)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--region', required=True)
    parser.add_argument('--profile')
    args = parser.parse_args()
    try:
        print(apply(json.loads(args.template.read_text()), json.loads(args.before.read_text()), args.region, args.profile))
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired):
        print('Policy application failed; inspect the reviewed template, prior snapshot and current bucket policy.', file=sys.stderr)
        sys.exit(1)
