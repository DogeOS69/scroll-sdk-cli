# Proof configuration through the saved deployment plan

The standalone `setup proof-config prepare` and `setup proof-config publish`
commands have been removed. The supported deployment interface has one source of
intent: the spec saved by `setup plan`. It does not accept a second proof request
JSON or adopt an old prepared-transaction receipt.

After completing genesis, AWS and bridge funding, follow the reported stages:

```bash
scrollsdk setup protocol-context --dir .
scrollsdk setup proof-materials --dir .
scrollsdk setup policy-prepare --dir .
scrollsdk setup proof-publish --dir .
scrollsdk setup signer-kit --dir .
scrollsdk setup signer-kit-publish --dir .
scrollsdk setup render --dir .
scrollsdk setup signer-session --dir .
scrollsdk setup upload-secrets --dir .
scrollsdk setup deployment-preflight --json
```

The saved plan determines which steps apply. Policy preparation and proof
materials share prerequisites; neither authorizes governance approval or signer
activation. Publication verifies immutable selected inputs and readback before
recording success. Resolve any reported operator handoff and rerun the same stage.
Rendering validates proof inputs in preparation scope; preflight uses activation
scope by default. Active/real deployments still require bound publication and
artifact-store receipts. Observe-mode readiness warnings are not activation.

After rollout, enforcing deployments additionally require fresh authenticated
polls from every registered Attestation signer:

```bash
scrollsdk setup deployment-preflight --proof-live \
  --kube-context <context> --namespace <namespace> --json
```

The internal isolated-candidate transaction library and its integrity tests remain
available to developers, but are not a supported operator upgrade interface.
Existing funded deployments require a reviewed upgrade preserving chain identity,
funding and receipt dependencies. Do not create a fresh plan or replay genesis to
bypass frozen-input checks. There is no legacy plan or transaction migration.
