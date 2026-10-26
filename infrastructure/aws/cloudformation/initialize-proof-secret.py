#!/usr/bin/env python3
"""Infrastructure operator action: initialize an empty proof Secret without printing credentials.

Never rotates an existing version. Run separately after the reviewed Secret stack.
Credentials use a private temporary input file, removed on exit; never arguments or output.
"""
import argparse
import json
import secrets
import subprocess
import sys
import hashlib
import tempfile
import os
from pathlib import Path


def initialize(secret_id, region, profile=None, run=subprocess.run):
    base = ['aws', '--region', region, '--no-cli-pager']
    if profile:
        base += ['--profile', profile]

    def call(args, payload=None):
        with tempfile.TemporaryDirectory(prefix='dogeos-secret-', dir='/dev/shm' if os.path.isdir('/dev/shm') else None) as temp:
            if payload is not None:
                file = Path(temp) / 'input.json'
                fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as stream:
                    stream.write(payload)
                args = [str(file) if value == '__PRIVATE_INPUT__' else value for value in args]
                args = ['file://' + value if value == str(file) else value for value in args]
            result = run(base + args + ['--output', 'json'],
                         capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ValueError('Secrets Manager request failed; provider output omitted')
        try:
            return json.loads(result.stdout)
        except (ValueError, TypeError):
            raise ValueError('Secrets Manager returned invalid metadata') from None

    metadata = call(['secretsmanager', 'describe-secret', '--secret-id', secret_id])
    if metadata.get('DeletedDate'):
        raise ValueError('The Secret is scheduled for deletion')
    if metadata.get('VersionIdsToStages'):
        return 'Existing Secret version preserved; no credentials read or changed'
    properties = {name: secrets.token_hex(32) for name in ['proof-work-token', 'prover-worker-master']}
    # A deployment runs this once, serially. A retry observes the version above and preserves it.
    call(['secretsmanager', 'put-secret-value', '--cli-input-json', '__PRIVATE_INPUT__'],
         json.dumps({'SecretId': secret_id, 'ClientRequestToken': hashlib.sha256(('dogeos-proof-init-v1:' + metadata['ARN']).encode()).hexdigest(),
                     'SecretString': json.dumps(properties)}))
    return 'Initialized proof credentials; values omitted'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--secret-id', required=True)
    parser.add_argument('--region', required=True)
    parser.add_argument('--profile')
    args = parser.parse_args()
    try:
        print(initialize(args.secret_id, args.region, args.profile))
    except (ValueError, subprocess.TimeoutExpired):
        print('Proof Secret initialization failed; inspect resource metadata and operator access. No credential values shown.', file=sys.stderr)
        sys.exit(1)
