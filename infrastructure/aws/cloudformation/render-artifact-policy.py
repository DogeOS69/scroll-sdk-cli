#!/usr/bin/env python3
"""Render a complete bucket-policy CloudFormation template, preserving existing grants.

Read the current policy with the infrastructure operator's AWS CLI first. Review
the generated template before applying it in the bucket's region. This program
does not call AWS, create buckets or change public-access-block settings.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re

PROOF_PATHS = ['input-specs/*', 'prepared-bundles/*', 'witnesses/*', 'public-outputs/*',
               'proofs/*', 'proof-programs/*', 'signer-policy-evidence/*', 'deployment-kits/*']


def render(existing, bucket, prefix, kind):
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket):
        raise ValueError('Invalid bucket name')
    prefix = prefix.strip('/')
    if not prefix or any(c in prefix for c in '*?${}'):
        raise ValueError('Supply a nonempty literal prefix')
    if kind not in ['archive', 'proof']:
        raise ValueError('Unknown artifact kind')
    policy = copy.deepcopy(existing)
    if 'Policy' in policy:
        policy = json.loads(policy['Policy'])
    if not isinstance(policy, dict):
        raise ValueError('Existing policy must be a JSON object')
    statements = policy.get('Statement', [])
    if isinstance(statements, dict):
        statements = [statements]
    sid = 'DogeosInfraPublicRead' + hashlib.sha256(f'{bucket}/{prefix}/{kind}'.encode()).hexdigest()[:20]
    grant = {'Sid': sid, 'Effect': 'Allow', 'Principal': '*', 'Action': 's3:GetObject',
             'Resource': [f'arn:aws:s3:::{bucket}/{prefix}/{suffix}' for suffix in (PROOF_PATHS if kind == 'proof' else ['*'])],
             'Condition': {'Bool': {'aws:SecureTransport': 'true'}}}
    if kind == 'archive':
        grant['Resource'] = grant['Resource'][0]
    matches = [st for st in statements if st.get('Sid') == sid]
    if matches and matches != [grant]:
        raise ValueError('Existing managed statement differs; review it explicitly')
    if not matches:
        statements.append(grant)
    policy.update(Version=policy.get('Version', '2012-10-17'), Statement=statements)
    return {'AWSTemplateFormatVersion': '2010-09-09',
            'Description': 'DogeOS externally managed complete artifact bucket policy. Preserve all other deployments.',
            'Resources': {'ArtifactPolicy': {'Type': 'AWS::S3::BucketPolicy', 'DeletionPolicy': 'Retain',
                           'UpdateReplacePolicy': 'Retain', 'Properties': {'Bucket': bucket, 'PolicyDocument': policy}}}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--existing-policy', type=Path, required=True)
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--prefix', required=True)
    parser.add_argument('--kind', choices=['archive', 'proof'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    template = render(json.loads(args.existing_policy.read_text()), args.bucket, args.prefix, args.kind)
    args.output.write_text(json.dumps(template, indent=2) + '\n')
    args.output.chmod(0o600)
    print('Rendered complete policy template; no AWS changes. Review and apply in the bucket region.')
