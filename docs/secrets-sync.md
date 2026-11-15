# Changing a secret value on a prepared deployment

A value such as an Ethereum RPC URL lives in the private environment file and
reaches several services: `deployment.env` feeds `$ENV:` references in
`.data/doge-config.toml` and `config.toml`, `setup gen-secrets` resolves them
into files under `secrets/`, `setup push-secrets` uploads those to AWS Secrets
Manager or Vault, and ExternalSecrets copy them into Kubernetes Secrets. One
value can be in many files; on a typical deployment the Ethereum RPC URL is in
seven.

`scrollsdk secrets sync` does those steps for whatever changed:

```bash
$EDITOR deployment.env

# Report only: changed files and key names, their ExternalSecrets and readers.
scrollsdk secrets sync --dir deployment --kube-context YOUR_CONTEXT

# Upload the changed files, force their ExternalSecrets to sync and wait for them.
scrollsdk secrets sync --dir deployment --kube-context YOUR_CONTEXT --apply
```

Then restart the workloads it lists, one at a time, when it is safe for each
service. It prints the exact commands, for example:

```text
kubectl --context YOUR_CONTEXT --namespace YOUR_NAMESPACE rollout restart statefulset/fee-oracle
```

No reloader is installed, so a running Pod keeps the old value until it
restarts. The command does not restart anything itself: some readers, such as
the DA submitter with a blob transaction pending, need the operator to choose
the moment.

## Behaviour

- It regenerates `secrets/` with `setup gen-secrets` from the current inputs
  and compares every file by digest. Without `--apply` it then puts the previous
  files back, so nothing changes locally or remotely.
- With `--apply` it uploads only the changed `.env` and `.json` files, each with
  `setup push-secrets --secret-file ... --skip-yaml-update` to the destination
  saved in the deployment (`preparation.secretUpload`, the AWS region and secret
  prefix). Values files are not touched; they already reference these secrets.
- It finds the ExternalSecrets whose remote key is one of the uploaded secrets,
  annotates them with `force-sync`, and waits up to two minutes for each to
  report `Ready` with a newer refresh time. A sync that does not confirm is
  reported as a warning.
- If an upload fails, the previous files are restored, so rerunning the command
  finds and uploads the same changes again. Uploads are idempotent.
- It refuses any change to a signing or node key (keys named like
  `*PRIVATE_KEY*`, `*SIGNER_KEY*` or `*NODEKEY*`, for example the sequencer
  signer, the withdrawal fee and sequencer signers, node keys and service
  account keys). These are never rotated on a running deployment.
- Kubernetes manifests in `secrets/` are not uploaded by this command. A
  changed dstack controller Secret is reported with its
  `setup push-secrets --dstack-only` command, and the Slack Secret with
  `setup monitoring-secrets --apply`.
- dstack provider keys are not handled here. When the environment holds a
  Vast.ai key that the dstack controller does not use, the output points to
  `scrollsdk capacity deploy`.
- A file removed from `secrets/`, or a change in a subdirectory of it, is
  reported but not uploaded or deleted: a removed file's store secret keeps its
  previous value until it is retired by hand.
- While it runs, `.scrollsdk/secrets-sync-backup/` holds the previous files. If
  the command is interrupted, the next run refuses until that directory has
  been compared with `secrets/` and removed.

Output contains file names, key names, secret names and workload names, never
values. Provider credentials are read from the environment file saved by
`setup plan`, `./deployment.env`, or `--env-file`.
