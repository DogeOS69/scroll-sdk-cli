"""Provision only a dstack project secret. No fleet or task creation."""
import importlib.metadata
import json
import os
import sys

from dstack.api.server import APIClient

try:
    if importlib.metadata.version('dstack') != '0.21.5':
        raise ValueError('Unsupported controller version')
    payload = json.load(sys.stdin)
    client = APIClient(base_url='http://127.0.0.1:3000', token=os.environ['DSTACK_SERVER_ADMIN_TOKEN'])
    # Validate the pre-existing fleet boundary before touching its credentials.
    for name in payload['fleets']:
        client.fleets.get(payload['project'], name)
    client.secrets.create_or_update(payload['project'], payload['secretName'], payload['token'])
    print('{"updated":true}')
except Exception:
    print('Capacity-manager credential preparation failed (private details omitted)', file=sys.stderr)
    sys.exit(1)
