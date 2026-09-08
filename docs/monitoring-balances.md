# Monitoring account balances

`scrollsdk setup prep-charts` generates the `balanceMonitoring` section in
`values/scroll-monitor-production.yaml`, including numbered production files.
Use scroll-monitor chart **0.1.26-dogeos or later**. Older chart versions do not
deploy the account balance exporter or its alerts.

The generator resolves public addresses from the canonical service signer
configuration in `.data/doge-config.toml` (or the file selected by
`--doge-config`). It does not use the legacy contracts compatibility address in
root `config.toml`, and it does not put private keys or KMS credentials in
monitoring values.

| Account | Address source in doge-config | RPC source | Expected chain ID | Default low-balance threshold |
| --- | --- | --- | --- | --- |
| fee-oracle | `accounts.L2_GAS_ORACLE_SENDER_ADDR`; verified against `signers.l2GasOracleSender.expectedAddress` for KMS | `config.toml`: `general.L2_RPC_ENDPOINT` | `config.toml`: `general.CHAIN_ID_L2` | 5 ETH units on L2 |
| eth-da-submitter | `accounts.L1_COMMIT_SENDER_ADDR`; verified against `signers.l1CommitSender.expectedAddress` for KMS | doge-config: `ethereumDa.submitterRpcUrl` | doge-config: `ethereumDa.chainId` | 0.1 ETH on Ethereum DA |
| fee_wallet | Existing Withdrawal Processor fee-wallet UTXO metric | Existing Prometheus scrape | Dogecoin deployment network | 100 DOGE |

The fee-oracle samples Ethereum DA gas prices but **spends on L2**. Its balance
must be queried through the L2 RPC. The two monitored native balances are
reported in units of 10^18 base units. The exporter checks `eth_chainId` before
accepting an `eth_getBalance` result.

For example, after configuring the service signers and RPC endpoints:

```bash
scrollsdk setup prep-charts --non-interactive --values-dir ./values
```

The generated section has this shape (addresses and chain IDs below are examples):

```yaml
balanceMonitoring:
  enabled: true
  feeWallet:
    enabled: true
    minimumDoge: 100
  ethereum:
    feeOracle:
      address: "0x1111111111111111111111111111111111111111"
      rpcUrl: http://l2-rpc:8545
      expectedChainId: "1234"
      minimumEth: 5
    ethDaSubmitter:
      address: "0x2222222222222222222222222222222222222222"
      rpcUrl: https://ethereum.example/rpc
      expectedChainId: "1"
      minimumEth: 0.1
  exporter:
    enabled: true
```

Helm maps the three fee-oracle connection fields to
`SCROLL_BALANCE_FEE_ORACLE_ADDRESS`, `SCROLL_BALANCE_FEE_ORACLE_RPC_URL`, and
`SCROLL_BALANCE_FEE_ORACLE_EXPECTED_CHAIN_ID`. The corresponding DA variables
are `SCROLL_BALANCE_ETH_DA_SUBMITTER_ADDRESS`,
`SCROLL_BALANCE_ETH_DA_SUBMITTER_RPC_URL`, and
`SCROLL_BALANCE_ETH_DA_SUBMITTER_EXPECTED_CHAIN_ID`.

Repeated generation refreshes addresses, RPC URLs, and expected chain IDs from
the deployment configuration, including after signer rotation. Missing signer
configuration, inconsistent KMS addresses, invalid RPC URLs, and invalid chain
IDs stop generation. Existing nonnegative numeric thresholds, exporter resource
settings, fee-wallet selectors, and Grafana/SMTP settings are preserved. Missing
thresholds receive the defaults above. The 100 DOGE fee-wallet threshold is an
initial operator setting, not a protocol minimum. The fee-wallet metric measures
canonical unredeemed UTXO value; it does not subtract transaction reservations
and is not a reservation-adjusted spendable balance.

To keep an RPC credential in a Kubernetes Secret, set
`balanceMonitoring.exporter.envFromSecret` to the existing Secret name and set
the corresponding account's `rpcUrl` explicitly to `""` in the values file.
The generator preserves that empty field, so the exporter reads the appropriate
`SCROLL_BALANCE_*_RPC_URL` variable from the Secret. Addresses and expected chain
IDs remain generated from the real deployment. A nonempty URL or `<TODO>` is
replaced with the configured RPC. RPC changes are redacted in command output;
nonempty generated URLs are still stored in the values file. This command does
not create or update the Secret. Restart the exporter after changing its Secret.

An explicit `balanceMonitoring.enabled: false` leaves the balance configuration
unchanged and requires no monitoring signer configuration. With only
`balanceMonitoring.exporter.enabled: false`, the generator fills missing
thresholds but leaves connection fields alone; an external exporter must supply
the metrics. `balanceMonitoring.feeWallet.enabled: false` is also preserved.

Thresholds in Helm values initialize newly created Grafana rules. Existing
Grafana rules retain UI edits across chart upgrades, so change their thresholds
in Grafana once they have been created. In the native Prometheus fallback,
thresholds follow Helm values. Configure Slack and email recipients in Grafana
contact points and notification policies; email also requires working SMTP
configuration. Consult the scroll-monitor chart README for alert migration,
SMTP configuration, and collection-failure alerts.
