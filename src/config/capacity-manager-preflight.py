"""Ephemeral in-cluster connectivity probe. Never prints credentials or bodies.

No worker/fleet mutations. Secret values arrive through Kubernetes Secret refs.
The public result reports only checks, not proof acceptance.
"""
import importlib.metadata
import ipaddress
import json
import os
import socket
import sys
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Redirects are not accepted')


CHECK = 'controller-version'


def main():
    global CHECK
    from dstack.api.server import APIClient
    if importlib.metadata.version('dstack') != '0.21.5':
        raise RuntimeError('Expected dstack 0.21.5 probe image')
    p = json.loads(os.environ['PROBE_INPUT'])
    CHECK = 'dns'
    url = urllib.parse.urlparse(p['url'])
    addresses = {r[4][0] for r in socket.getaddrinfo(url.hostname, url.port or 443, type=socket.SOCK_STREAM)}
    private = all(ipaddress.ip_address(a).is_private and not ipaddress.ip_address(a).is_loopback for a in addresses)
    if not addresses or (p['privateDns'] and not private):
        raise RuntimeError('Private endpoint did not resolve to private addresses')
    # Mounting/checking all three references detects missing Secret keys before
    # creating any fleets. The master never leaves this probe.
    CHECK = 'secret-references'
    for key in ['DSTACK_TOKEN', 'WP_TOKEN', 'WORKER_MASTER']:
        if not os.environ[key].strip():
            raise RuntimeError('An empty Secret key was provided')
    CHECK = 'dstack-tls-auth-project-backend'
    client = APIClient(base_url=p['url'], token=os.environ['DSTACK_TOKEN'])
    project = client.projects.get(p['project'])
    if p['provider'] not in {b.config.type for b in project.backends}:
        raise RuntimeError('Required dstack backend is absent')
    CHECK = 'wp-capacity-api'
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(p['wpUrl'].rstrip('/') + '/v1/proof-work/capacity/summary',
                                     headers={'Authorization': 'Bearer ' + os.environ['WP_TOKEN'].strip()})
    with opener.open(request, timeout=20) as response:
        body = json.loads(response.read(4 * 1024 * 1024))
        if response.status != 200 or not isinstance(body, dict):
            raise RuntimeError('Invalid WP capacity response')
    print(json.dumps({'dns': 'passed', 'privateDns': private, 'dstackTlsAuthProjectBackend': 'passed',
                      'wpCapacityApi': 'passed', 'secretReferences': 'passed', 'proofAcceptance': 'not-tested'}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'failed', 'check': CHECK}))
        sys.exit(1)
