"""Prepare reviewed empty fleets using dstack 0.21.5.

Workers get per-run credentials minted by the capacity manager (dogeos-core
#1598); this adapter no longer stores any worker secret in the project.

Runs inside the controller. API/provider exceptions may contain credentials and
are deliberately omitted. Never starts runs, changes existing fleets, or forces
an apply. Project/backend configuration comes from the controller server config.
"""
import importlib.metadata
import json
import os
import sys

from dstack._internal.core.models.fleets import ApplyFleetPlanInput, FleetSpec
from dstack._internal.core.models.profiles import ProfileParams
from dstack.api.server import APIClient


class PreparationError(Exception):
    """Only locally constructed, public diagnostic messages."""


def canonical(spec):
    # dstack merges configuration placement fields over the selected profile.
    # Compare that effective meaning, not where a field was written or the
    # operator's profile name. All other configuration fields remain checked.
    config = spec.configuration.model_dump(mode='json')
    for field in ProfileParams.model_fields:
        config.pop(field, None)
    profile = spec.merged_profile.model_dump(mode='json', exclude={'name', 'default'})
    return {'configuration': config, 'profile': profile}


def prepare(client, payload):
    project = payload['project']
    if payload['fleetAction'] not in ('create', 'reuse') or not payload['fleets']:
        raise PreparationError('Missing reviewed fleet intent; rerun setup render')
    desired = [FleetSpec.model_validate({'configuration': c, 'profile': {}})
               for c in payload['fleets']]
    for spec in desired:
        nodes = spec.configuration.nodes
        if spec.configuration.ssh_config or not nodes or nodes.min != 0 or nodes.target != 0 or not nodes.max:
            raise PreparationError('Fleet preparation requires zero initial/minimum instances and a finite maximum')
    if len({s.configuration.name for s in desired}) != len(desired):
        raise PreparationError('Duplicate fleet names')
    # Project metadata exposes backend types, without reading provider credentials.
    backends = {backend.config.type for backend in client.projects.get(project).backends}
    if any(not spec.merged_profile.backends or not set(spec.merged_profile.backends).issubset(backends) for spec in desired):
        raise PreparationError('Selected provider backend is missing from the project; check controller startup configuration')
    # A successful list distinguishes absence from authentication/project errors.
    existing = {fleet.name: fleet for fleet in client.fleets.list(project)}
    # Validate every existing fleet before performing any writes.
    for spec in desired:
        fleet = existing.get(spec.configuration.name)
        if fleet and (canonical(fleet.spec) != canonical(spec)
                      or fleet.status.value not in ('active', 'submitted')):
            raise PreparationError('Existing fleet differs from the reviewed configuration or is not active; no fleet was changed')
        if not fleet and payload['fleetAction'] == 'reuse':
            raise PreparationError('Required existing fleet is missing; choose create or prepare the declared fleet')
    created = 0
    for spec in desired:
        if spec.configuration.name in existing:
            continue
        plan = client.fleets.get_plan(project, spec)
        if plan.current_resource is not None:
            raise PreparationError('Fleet appeared concurrently; retry to check it without updating it')
        if canonical(plan.get_effective_spec()) != canonical(spec):
            raise PreparationError('Dstack changed the requested fleet plan; review controller policies before retrying')
        # current_resource=None and force=False make a concurrent create fail,
        # instead of overwriting somebody else's fleet. target=0 rents nothing.
        fleet = client.fleets.apply_plan(project, ApplyFleetPlanInput(spec=spec), force=False)
        if canonical(fleet.spec) != canonical(spec):
            raise PreparationError('Created fleet readback differs; inspect controller policies before continuing')
        created += 1
    return {'createdEmptyFleets': created, 'updated': True}


def main():
    try:
        if importlib.metadata.version('dstack') != '0.21.5':
            raise PreparationError('Unsupported controller version; expected dstack 0.21.5')
        client = APIClient(base_url='http://127.0.0.1:3000', token=os.environ['DSTACK_SERVER_ADMIN_TOKEN'])
        print(json.dumps(prepare(client, json.load(sys.stdin))))
    except PreparationError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Capacity-manager fleet preparation failed; check project/backend availability (private details omitted)', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
