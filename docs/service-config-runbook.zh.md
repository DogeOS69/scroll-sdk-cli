# DogeOS 核心服务配置 Runbook（中文）

> [!WARNING]
> **个人/内部笔记，不属于正式使用手册。** 本文件仅用于作者自己的中文梳理，
> 不应加入 README、正式文档导航或对外发布包。桥运营方的正式流程以
> `docs/proof-operator-runbook.md` 为准，合作方流程以
> `scroll-sdk/partner-kit/attestation-signer/README.md` 为准。

> 覆盖五个服务的配置生成与部署主线：**attestation-signer**、**withdrawal-processor**、
> **proof-coordinator**、**prover-worker**、**tso-service**。

## 1. 仓库分工

| 仓库 | 角色 |
|---|---|
| `scroll-sdk` | Helm chart 与模板。K8s proof 服务的 chart 在 `charts/withdrawal-processor`、`charts/tso-service`、`charts/proof-coordinator`；attestation-signer 不提供 chart，只在 `partner-kit/attestation-signer/` 提供合作方 docker-compose 参考部署；`examples/Makefile.example` 是 K8s 安装入口 |
| `scroll-sdk-cli` | 配置生成工具（`scrollsdk` 命令）。读写部署工作目录里的 `config.toml`、`.data/`、`values/`、`secrets/` 等，生成/校验所有 values 与 TOML |
| `dogeos-core` | 服务本体（Rust）。prover-worker 的二进制与操作文档在这里：`tools/scroll-runtime-materializer/PROVER_WORKER.md`、`docs/engineering/real-proving-runner.md` |

**prover-worker 不是 Helm chart**——它是运行在集群外（真实模式通常为 GPU
主机）的长驻 daemon。真实模式的发布件/运行参数由 GPU 运维流程管理；mock 模式
由 CLI 直接生成 `prover-worker-mock/docker-compose/`。两种模式都使用
`setup proof-aws-init` 创建的 `prover-worker-token` 与 proof-coordinator 拓扑。

## 2. 服务拓扑

```
                    合作方网络                      桥运营方 (k8s 集群)
              ┌──────────────────┐          ┌─────────────────────────────────┐
              │ attestation-     │  /sign   │  tso-service                    │
              │ signer × N       │◀─────────│    ▲ tsoSigners (来自 WP 值)     │
              │ (docker-compose) │──────────▶    │                            │
              └──────┬───────────┘ 签名回调  │  withdrawal-processor           │
                     │ HTTPS GET            │    │ proof_work_api :9300       │
                     ▼ proof artifacts      │    ▼                            │
              ┌──────────────────┐          │  proof-coordinator              │
              │ S3 / CDN         │◀─────────│    │ /v1/prover 网关            │
              │ (proof-artifacts)│  签名 PUT └────┼────────────────────────────┘
              └──────▲───────────┘               │ claim / heartbeat / result
                     │ GET inputs                │ (prover-worker-token)
              ┌──────┴───────────┐               │
              │ prover-worker    │◀──────────────┘
              │ (集群外 GPU 主机) │
              └──────────────────┘
```

- **attestation-signer**：由各自运营方（合作方或我们自己按同一流程）独立部署，
  桥运营方只收 `descriptor.json`、发回 policy bundle。
- **tso-service**：集群内服务，向各 signer 发 `/sign` 请求；signer 名单来自
  withdrawal-processor values 的 `tsoSigners` 数组。
- **withdrawal-processor**：应用配置为 TOML 所有制
  （`withdrawal-processor/WithdrawalProcessor.toml`），values 只保留 k8s 形态、
  secret 接线和 `withdrawalProof.enabled` 总开关。
- **prover-worker**：不可信、只做证明。凭 worker token 从 proof-coordinator 的
  `/v1/prover` 网关领任务，从 artifact store 读输入（裸 GET），用签名 PUT 上传证明。

## 3. 工作目录布局与通用约定

所有 `scrollsdk` 命令在**部署工作目录**中执行（不是仓库目录），布局：

```
deployment/
├── config.toml                    # 主配置（手工/generate-from-spec 生成）
├── config-contracts.toml
├── .data/
│   ├── doge-config.toml           # setup doge-config 生成
│   ├── setup_defaults.toml        # attestation_pubkeys / threshold / tee_pubkey
│   ├── protocol_context.json      # bridge-init 产物
│   ├── protocol_context.protocol_id  # bridge-init 产物（protocol instance id sidecar）
│   ├── GenerateBridgeInfo.toml    # bridge-init 产物 (namespace_id)
│   └── output-withdrawal-processor.toml
├── values/                        # 所有 *-production.yaml（prep-charts 维护）
├── secrets/                       # gen-secrets 产物（*.env）
├── proof-artifacts/               # 发布的证明工件（release.json + manifests/）
├── proof-coordinator/ProofCoordinator.toml
├── withdrawal-processor/WithdrawalProcessor.toml
├── descriptors/                   # 收到的合作方 signer descriptor JSON
├── prover-worker-mock/docker-compose/ # proof-config mock 产物
├── signer-policy-bundle/           # export-signer-policy 产物
└── Makefile                       # 从 scroll-sdk/examples/Makefile.example 复制
```

通用 flags：所有 setup 命令支持 `-N`（非交互）与 `--json`（结构化输出，日志走
stderr）。secret 值可在 config 里写 `$ENV:VAR_NAME` 引用环境变量。
详见 `docs/automation.md`。

## 4. 总时间线（四个服务视角）

```
 signer 运营方（每家各自执行）              桥运营方（你，在部署工作目录）
 ───────────────────────────              ────────────────────────────────
 ① scrollsdk signer init                   scrollsdk setup doge-config
 ② docker compose up -d                    ……常规主线（domains/db-init/
 ③ scrollsdk signer preflight                gen-keystore/gen-l2-artifacts/
      │ descriptor.json                      cubesigner-init）
      └──────────────────────────────────▶ ④ setup attestation-signer --probe
                                           ⑤ setup bridge-init --step all
                                           ⑥ setup gen-secrets
                                           ⑦ setup prep-charts        ← tsoSigners、WP TOML
                                           ⑧ setup proof-aws-init    ← S3/IRSA/双 token
                                           ⑨ setup proof-config      ← 三族 verifier 拓扑
                                           ⑩ setup export-signer-policy
      ◀──────────────────────────────────────┘ policy bundle（全体相同）
 ⑪ 应用 bundle + docker compose up -d（mock/production 命令相同）
                                           ⑫ setup push-secrets / setup tls
                                           ⑬ make install-withdrawal-processor
                                              make install-proof-coordinator
                                              make install-tso
                                           ⑭ 部署 prover-worker（集群外）
                                           ⑮ setup proof-config --enable-withdrawal-proof
                                              + helm 重装 WP（打开总开关）
```

以下按服务分节，每节列出**只与该服务相关**的命令与产物。

## 5. attestation-signer（docker-compose，合作方运营）

完整双侧文档：

- signer 运营方 runbook：`scroll-sdk/partner-kit/attestation-signer/README.md`
- 桥运营方 runbook：本仓库 `docs/proof-operator-runbook.md`

### 5.1 signer 运营方侧（合作方执行，我们自营 signer 走同一流程）

```bash
# ① 生成密钥 + 部署 env + descriptor（写入 signer-<id>/ 目录）
scrollsdk signer init --id <约定的signer-id> --network testnet \
  --endpoint https://signer.your-org.example:4040
#   AWS KMS 变体（生产推荐）:
scrollsdk signer init --id <id> --network testnet \
  --endpoint https://signer.your-org.example:4040 \
  --backend aws-kms --kms-key-id <KeyId-or-Arn> --kms-region <region> \
  --allowed-release-version <批准的Cargo版本> \
  --allowed-git-commit <批准镜像内嵌的完整40字符git-sha>
#   或 --backend aws-kms --create-key --kms-region <region> 由 CLI 代建 key

# ② docker-compose 部署（partner-kit/attestation-signer/docker-compose/）
cd docker-compose/
cp ../signer-<id>/attestation-signer.env . && chmod 600 attestation-signer.env
mkdir -p policy          # 收到 bundle 前为空
docker compose up -d
curl -fsS http://localhost:4040/health    # 返回 public_key

# ③ 校验并回填 endpoint，产出最终 descriptor.json → 发给桥运营方
scrollsdk signer preflight --dir ../signer-<id>
```

`docker-compose.yml` 期望旁边有三样东西：`attestation-signer.env`（密钥后端，
SECRET）、`signer-policy.env`（创世后 bundle，来前是占位）、`policy/`
（bundle 里的 `verifier-registry.toml` + `source-set.toml`）。SQLite 卷
`signer-data` 存审计库，必须持久化；**同一把 key 永远只跑一个实例**。

### 5.2 桥运营方侧

```bash
# ④ 导入全部 descriptor，选定初始 keyset（在 bridge-init 之前！）
#    descriptor 默认取工作目录 descriptors/*.json，非标准布局才需要
#    --descriptor / --descriptor-dir
scrollsdk setup attestation-signer \
  --threshold 2 \
  --active-signer-ids partner-a,partner-b,ours-0 \
  --probe          # 逐个 GET /health 并要求运行时公钥与 descriptor 一致
```

写入两处：`.data/doge-config.toml`（`[attestationSigner] mode="external"` +
`signerUrls`）和 `.data/setup_defaults.toml`（`attestation_pubkeys` /
`attestation_key_count` / `attestation_threshold`）。校验规则：网络匹配、
公钥在曲线上、id/公钥/endpoint 三者全局唯一。
**descriptor 公钥在创世时永久进入 redeem script——probe 要在 bridge-init 之前做。**

```bash
# ⑤ 桥创世（不因外部 signer 而有任何变化）
scrollsdk setup bridge-init -N --json --step all --seed <seed>

# ⑩ 创世后导出 policy bundle（全体 signer 同一份）
#    标准工作目录布局下全部输入自动推导，flag 只用于覆盖
scrollsdk setup export-signer-policy
```

自动推导（每项推导都会带来源打印，可审计）：

| 输入 | 来源 |
|---|---|
| `activeBridgeKeyHash` | `.data/protocol_context.json`（`genesis.genesis_bridge_key_hash`） |
| `--bridge-namespace-id` | `.data/GenerateBridgeInfo.toml`（`namespace_id`） |
| `--protocol-instance-id` | `.data/protocol_context.protocol_id`（bridge-init step 5 的 sidecar，需要带该功能的 dogeos-core 镜像） |
| `--tso-url` | `config.toml` 的 `[ingress].TSO_HOST` → `https://<host>` |
| `--signer-proof-artifact-base-url` | proof-config（⑨）写进 `withdrawal-processor/WithdrawalProcessor.toml` 的 `[proof_system].signer_proof_artifact_base_url` |
| `--allowed-proof-triples` | 优先 `ProofCoordinator.toml` 的 managed verifier 块（含 `--verifier-id` 覆盖），其次 `proof-artifacts/` manifests；proof-backed policy 缺失三元组时 fail-closed |
| `--tee-allowed-signer-ids` | production 从 `.data/setup_defaults.toml` 的 `tee_pubkey` 推导；mock 默认留空以对齐 e2e_harness。CLI 接受 CubeSigner 的 `04+X+Y` 与 canonical `02/03+X`，写入 policy 前统一压缩 |
| signer verifier registry | 默认从上述 proof triples 直接生成，确保 signer 与 WP/coordinator 使用同一组 `(proof_kind, verifier_id, vk_hash)`；只有迁移时才传 `--verifier-registry` |
| signer source set | mock 自动生成 e2e_harness 空 scaffold；production 固定读取 `configs/source-set.toml`，非标准迁移才传 `--source-set` |

前五项推导不出来会直接报错（提示先跑对应步骤或手动传 flag）；proof-backed
policy 也必须有至少一个 proof triple。production policy 必须有 TEE signer id，mock 不读取也不校验
`tee_pubkey`，除非运营方显式传 `--tee-allowed-signer-ids` 覆盖。产物目录
`signer-policy-bundle/`：

| 文件 | signer 运营方的用法 |
|---|---|
| `signer-policy.env` | 替换 compose 目录里的 `signer-policy.env` |
| `verifier-registry.toml`、`source-set.toml` | CLI 按 mode 生成/选择；合作方复制进 `docker-compose/policy/` |
| `signer-policy.json` | 机读摘要，留档 |
| `PARTNER-COMMANDS.md` | 已代入本次 mode、每个 signer endpoint、公钥、TSO URL、proof GET 根地址的双侧精确命令 |

注意 TSO URL 必须是**从合作方网络可达**的地址（签名回调用），不能是集群内
service 名——ingress 域名不是合作方侧地址时用 `--tso-url` 覆盖。
signer↔TSO 之间目前没有应用层认证，连通性必须私有
（VPN / WireGuard / IP 白名单 TLS 反代），机制与每家合作方逐一约定。

### 5.3 mock 与 production 的流程同构边界

两种模式下合作方不需要学习两套流程：`signer init` → compose →
`signer preflight` → 交 descriptor → 收 policy bundle → 复制三个运行时策略文件 →
compose 重启 → TSO `/sign` → signer 下载 proof → 回调 TSO，命令和网络方向完全相同。
`setup export-signer-policy` 从 doge-config 中读取 proof-config 已持久化的
`provingMode`，合作方无需再次传模式开关。

差异只在 bundle 里的安全姿态：

| 模式 | policy env | 含义 |
|---|---|---|
| mock | `POLICY_MODE=staging_scaffold`、`ALLOW_UNIMPLEMENTED_CHECKS=true`、TEE allowlist 默认空 | 对齐 e2e_harness；所有已实现检查、proof HTTP 下载、审计和回调仍执行，只审计放行确定性假 proof 无法满足的未实现生产检查 |
| production | `POLICY_MODE=production_enforce`、`ALLOW_UNIMPLEMENTED_CHECKS=false`、TEE allowlist 必填 | fail-closed；合作方还必须在自己持有的 `attestation-signer.env` 中固定批准镜像的 release version、完整 git commit 和 signing policy version |

两种 bundle 都写入 `ENVELOPE_MAX_PROOF_ARTIFACTS=4`。production 同时写入普通与
envelope 的 TEE signer allowlist；mock 的两个 TEE allowlist 默认为空，因为当前
e2e_harness evidence 不携带 TEE receipt。attestation-signer 的默认 artifact cap
是 0；若缺少正数 cap，所有携带 proof 的签名请求都会被正确拒绝。

`cubesigner-init` 会在 `.data/doge-config.toml` 同时保存 CubeSigner API 原样返回的
`public_key`（通常是 65 字节 `04+X+Y`，方便和 `cs` 输出逐字核对）和验证后生成的
`public_key_compressed`（33 字节 `02/03+X`）。`setup_defaults.toml` 只写后者。
旧部署仍可保留原文件：production
policy 导出会只读兼容转换。压缩前后是同一曲线点，不改变 `protocol_id`；
dogeos-core 在生成 redeem script 时本来就固定写入压缩公钥，而
`generate_protocol_context` 哈希的是生成后的 bridge script，不是原始 TOML 字符串。

注意：当前 dogeos-core 的 attestation-signer 对 STARK proof bytes 的密码学验证仍
报告 `NotImplemented`，因此 `production_enforce` 会按设计拒绝 proof-backed
签名，直到使用实现该检查的 signer release。mock 是当前用于验证完整部署、网络、
proof 下载、TSO 回调和审计流程的通道，不能用于有价值资产的桥。

endpoint 必须按“调用者视角”填写：生产推荐
`https://signer.partner.example:4040`；隔离的 VPN/mock 测试可用
`http://10.20.30.40:4040`。不得填写 `localhost`、Docker 内部服务名或合作方内部
K8s 名。桥运营方先在工作机执行 `--probe`，部署后还要从 TSO 所在 namespace
复测：

```bash
kubectl -n <namespace> run signer-reachability --rm -i --restart=Never \
  --image=curlimages/curl:8.20.0 -- \
  curl -fsS https://signer.partner.example:4040/health
```

## 6. withdrawal-processor

配置分三层：secret env（gen-secrets）→ 原生 TOML + values（prep-charts）→
proof 块（proof-config，见 §7）。

```bash
# ⑥ 生成 secrets/withdrawal-processor-secret.env
scrollsdk setup gen-secrets -N --json
```

内容：`DOGEOS_WITHDRAWAL_DOGECOIN_RPC_USER/PASS`（来自 doge-config 的
`dogecoinClusterRpc`）、`DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY`、
`DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY`（来自 bridge-init 产物
`.data/output-withdrawal-processor.toml`——所以必须先跑 ⑤）。

```bash
# ⑦ 渲染 values 与原生 TOML
scrollsdk setup prep-charts -N --json
```

prep-charts 对 WP 做的事：

- 维护 `withdrawal-processor/WithdrawalProcessor.toml` 顶部的
  **managed deployment block**（`# BEGIN/END scrollsdk managed deployment
  configuration`）：每次运行合并派生事实（RPC URL、合约地址、chain id、起始高度、
  redeem script、blob source），你在块内手调的键（费率、超时、UTXO 策略等）
  跨运行保留，块内注释不保留。
- 重建 values 里的 **`tsoSigners`** 数组 = cubesigner roles（`role: Tee`，
  `http://cubesigner-signer-<i>:3000`）+ doge-config `signerUrls` 里的外部
  attestation signer endpoint（`role: Attestation`）。TSO 通过这个数组认识全部
  signer——外部 signer 模式下 prep-charts **不再**渲染任何
  attestation-signer values 文件（并清掉旧的）。
- 保证 `withdrawalProof.enabled` 总开关存在（默认 false，见 §7）。
- 把 legacy 的内联 TOML/`DOGEOS_WITHDRAWAL_*` env 迁移进原生 TOML。

```bash
# ⑫ secret 上云 + TLS
scrollsdk setup push-secrets -N --json --aws-region $AWS_REGION
scrollsdk setup tls -N --json --cluster-issuer letsencrypt-prod

# ⑬ 安装（Makefile 来自 scroll-sdk/examples/Makefile.example）
make install-withdrawal-processor
# 等价于:
# helm upgrade -i withdrawal-processor oci://ghcr.io/dogeos69/scroll-sdk/helm/withdrawal-processor \
#   -n <ns> --values values/withdrawal-processor-production.yaml \
#   --set-file 'configMaps.config.data.WithdrawalProcessor\.toml'=withdrawal-processor/WithdrawalProcessor.toml
```

## 7. proof 拓扑与 prover-worker

### 7.1 setup proof-aws-init —— 云资源 + 双 token

```bash
scrollsdk setup proof-aws-init \
  --aws-region us-west-2 \
  --eks-cluster <cluster> \
  --network-alias <alias>        # 需要 values/{proof-coordinator,withdrawal-processor}-production.yaml 已存在
```

幂等创建并回写 values：

- S3 桶 `dogeos-<alias>-proof-artifacts`（私有、SSE-S3）；
- 两个 IRSA 角色：`dogeos-<alias>-<cluster>-proof-coordinator` 和
  `dogeos-<alias>-<cluster>-wp-proof`，绑到对应 service account，授
  `s3:GetObject/PutObject` + `s3:ListBucket`；
- Secrets Manager secret `scroll/proof-coordinator-secrets`，装两枚随机 token：
  **`proof-work-token`**（coordinator ↔ WP 的 proof_work_api）和
  **`prover-worker-token`**（prover-worker ↔ coordinator `/v1/prover`）。
  已存在则复用；`--rotate-tokens` 轮换后两个工作负载都要重启。

### 7.2 setup proof-config —— 三族 verifier 拓扑

proof-config 有两种 proving 模式，由唯一模式开关
`--proving-mode mock|production` 指定并
持久化到 `.data/doge-config.toml` 的 `[proofSystem].provingMode`（之后所有
重跑与 prep-charts 自动沿用；默认 production）。

**mock 模式**（`--proving-mode mock`）：面向部署工具完整性测试——全部服务
（WP、coordinator、attestation-signer、TSO、prover-worker）照常启动、链接关系
与生产完全一致，只有证明生成与验证是确定性 mock（dev_dummy verifier +
prover-worker-mock）。不需要发布件：三个 mock ProofProgramManifestV1 自动合成
（身份常量与 dogeos-core e2e strict-withdrawal 拓扑一致），bridge gate 全开
（signer 走完整 proof-artifact fetch 链路）。额外产物：

- `prover-worker-mock/docker-compose/`：worker 接入包（compose + URL env +
  含 token 的 `prover-worker.env`，token 自动读自 SM
  `scroll/proof-coordinator-secrets`；`--skip-worker-bundle` 跳过）。
  coordinator 对外 URL 取 `config.toml [ingress].PROOF_COORDINATOR_HOST`
  （CLI 同时把该 host 渲染成 coordinator values 的 HTTPS ingress）。
- coordinator TOML 缺失时自动 scaffold（已有文件绝不覆盖；只有希望缺失即报错时
  才传 `--no-scaffold-coordinator-config`），mock 下生成 dev-sentinel
  scroll materializer + 真 bridge materializer 形态；两种模式的 materializer
  形态互斥，切换时校验 fail-closed 并提示重新 scaffold。
- **绝不允许对承载真实资产的桥使用 mock 模式**——每次运行都会醒目告警。

**production 模式**前提：`proof-artifacts/`（发布件：`release.json` +
`manifests/scroll-chunk.json` + `scroll-batch.json` + `bridge-transition.json`）
已放进工作目录。生产 verifier 身份**必须**来自发布件，禁止手抄进 values。

```bash
# mock：首跑必须给公共 proof 对象根 URL；worker 用它读输入，signer 通过签名请求
# 中的完整 URL 读 accepted proof；之后重跑自动沿用落盘值。
scrollsdk setup proof-config \
  --proving-mode mock \
  --proof-artifact-base-url https://proofs.example.com/proof-topology

# production：同一命令/目录流程，只切换唯一 mode；并要求 proof-artifacts/ 发布件。
scrollsdk setup proof-config \
  --proving-mode production \
  --proof-artifact-base-url https://proofs.example.com/proof-topology
```

标准目录下不需要任何路径参数；从别处运行时只传
`--deployment-dir /path/to/deployment`。`values-dir`、两个 TOML、release manifest
与三个 program manifest 都按本章约定从该根目录推导。各个路径 flag 只用于迁移
非标准旧目录。

做的事（全部产物先通过 preflight 校验才落盘）：

- 校验三个 ProofProgramManifestV1、raw commitment 的 SHA-256、release 的
  VK/program hash、聚合 verifying key 校验和；聚合 key 以 base64 嵌入带校验和的
  ConfigMap，由 init container 装到 `/app/data/verifier/agg-vk.bin`（WP 与
  coordinator 都装）。
- 只替换 `proof-coordinator/ProofCoordinator.toml` 中带标记的 verifier 块、
  和 `WithdrawalProcessor.toml` 中带标记的 proof 块；深层 materializer 拓扑
  （二进制路径、RPC、blob source、`[materializer.bridge.*]` 等）保持手工维护，
  缺失则 fail-closed。
- 生成 `statement-namespace.json`、配置共享 proof-work token、暴露 WP 内部
  9300 端口、把 S3 artifact store 投影进 WP。
- **attestation-signer 策略校验**：提前验证 verifier id 可安全导出为
  `proof_kind:verifier_id:vk_hash` CSV，但不读写任何 signer Helm values（该部署形态
  已淘汰）。§5.2 的 `export-signer-policy` 自动从 staged
  `ProofCoordinator.toml` verifier 块推导同一批 triple，写进合作方 compose 的
  policy bundle，无需 skip flag 或手抄。

**默认不激活 proof**。唯一激活开关是 WP values 的 `withdrawalProof.enabled`，
在 coordinator 就绪、S3 身份、对应模式的证明材料/worker 各自 preflight 通过之前
保持 false。全通过后：

```bash
# 重跑不必重复 base URL（沿用首跑落盘的值）
scrollsdk setup proof-config --enable-withdrawal-proof
make install-withdrawal-processor install-proof-coordinator
```

```bash
# coordinator 安装（Makefile 目标）
make install-proof-coordinator
# helm upgrade -i proof-coordinator oci://.../proof-coordinator \
#   --values values/proof-coordinator-production.yaml \
#   --set-file proofCoordinator.config.content=proof-coordinator/ProofCoordinator.toml
```

### 7.3 prover-worker（集群外部署）

权威文档在 dogeos-core：`tools/scroll-runtime-materializer/PROVER_WORKER.md`
（CLI 与信任边界）、`docs/engineering/real-proving-runner.md`（生产 CUDA 镜像与
运维 runbook）。要点：

```bash
prover-worker \
  --proof-coordinator-url https://<coordinator 对外网关>   \  # /v1/prover 基址（不带路径）
  --artifact-read-base-url https://<artifact-store 读基址> \  # GET base_url/key 读输入
  --worker-token-file /run/secrets/prover-worker-token     \  # §7.1 的 prover-worker-token
  --worker-id <稳定唯一 id>                                 \
  --mode real \
  --enable-prove-scroll-chunk --chunk-app-exe .../app.vmexe --chunk-app-config .../openvm.toml \
  --enable-prove-scroll-batch --batch-app-exe .../app.vmexe --batch-app-config .../openvm.toml \
  --enable-prove-bridge-transition
```

- token 从 Secrets Manager `scroll/proof-coordinator-secrets` 的
  `prover-worker-token` 取（也可 `DOGEOS_PROVER_WORKER_TOKEN` env）。
- 无任何 DB/对象存储凭证、不触达 WP：读输入走裸 GET，上传走 coordinator 签发的
  签名 PUT URL。coordinator 的 `PROVER_API__PUBLIC_S3_ENDPOINT_URL` 决定 worker
  可见的 S3 端点——它与 signer 用的 `--signer-proof-artifact-base-url` 是
  **两个不同的口子**，别混用。
- GPU 是编译期选择（`--no-default-features --features cuda`）；每个能力不显式
  `--enable-*` 就不开，无能力启动会直接失败。
- 生产运行**绝不**带 `--mode mock` / `--allow-dev-mock-prover`；mock 仅
  `dev-mock-prover` 特性构建可用（CI/开发环境，如 dogeos-core 的
  prover-worker-mock CI docker 模块）。
- 默认远端 profile：`scroll-prod-zkvm-batch-v1` / `bridge-prod-zkvm-v1`，与
  proof-config 的 `--scroll-batch-backend-profile` / `--bridge-backend-profile`
  必须对得上。

### 7.4 mock 完整流程验收门

mock 的通过标准不是“配置文件生成成功”或“Pod 全绿”，而是至少完成一次真实的
withdrawal 业务链路。建议使用 CLI 已有的多 withdrawal 集成用例（需要相应测试
账户、RPC 和合约前置条件）：

```bash
# 先确认 partner 已应用 signer-policy-bundle，所有外部地址双向可达，worker 已启动。
scrollsdk setup proof-config --enable-withdrawal-proof
make install-withdrawal-processor install-proof-coordinator install-tso

# 发起实际 L2 → Dogecoin withdrawal，等待完整 proof/signature/finalization 链路。
scrollsdk test dogeos 4
```

本次验收必须同时收集以下证据；任何一项缺失都不能算流程测试通过：

1. proof-coordinator 接受 WP proof work，外部 worker 完成 claim、heartbeat、result；
2. `prover-worker-mock` 日志明确为 `--mode mock`，三种 capability 均已注册；
3. WP 只在 coordinator receipt/import/readiness 完成后进入签名阶段；
4. TSO 向 descriptor 中的合作方 endpoint 发送真实 `POST /sign`；
5. 合作方 signer 通过完整 `proof_artifact_fetch.url` 执行 HTTP GET、校验 size/SHA-256，
   并在 SQLite 中留下请求、policy verdict 和 audit 记录；
6. signer 向 policy bundle 中的 TSO 域名/IP 回调，TSO 接受 Attestation role；
7. withdrawal 最终完成，而不是仅在 mock worker 处生成一个文件。

因此，合作方不需要一套“mock 专用命令”。它执行 `PARTNER-COMMANDS.md` 中与生产
相同的两阶段命令；bundle 内的 `staging_scaffold` 是唯一显式的测试安全差异。

## 8. tso-service

TSO 没有独立的生成命令，配置全部由 prep-charts 维护：

- `values/tso-service-production.yaml` 的 env：`DOGE_NETWORK`（来自 doge-config
  network）、`WITHDRAWAL_PROCESSOR_URL=http://withdrawal-processor:3000`、
  `TIMEOUT_CHECK_INTERVAL_SECONDS`、`TSO_*_MAX_PSBT_BASE64_LEN` 等；
- ingress host 取 `config.toml` `[ingress].TSO_HOST`（`export-signer-policy`
  的 TSO URL 默认值就从它推导：`https://<TSO_HOST>`）；
- signer 名单不在 TSO values 里——TSO 经 WP values 的 `tsoSigners`
  （§6，prep-charts 每次重建）得知全部 Tee + Attestation signer。

```bash
make install-tso
# helm upgrade -i tso-service oci://ghcr.io/dogeos69/scroll-sdk/helm/tso-service \
#   -n <ns> --values values/tso-service-production.yaml --wait
```

对外部 signer 的网络要求（双向都要通，与每家合作方约定机制）：
TSO → signer `POST /sign` / `GET /health`；signer → TSO 回调；signer →
签名请求 `required_proof_artifacts[].proof_artifact_fetch.url` 中的完整 HTTPS
对象地址 GET（其根地址由 `signerProofArtifactBaseUrl` 生成）。

## 9. 产物速查表

| 命令 | 读 | 写 |
|---|---|---|
| `signer init`（合作方） | — | `signer-<id>/attestation-signer.env`、`descriptor.json` |
| `signer preflight`（合作方） | `signer-<id>/`、运行中 signer `/health` | 回填 `descriptor.json` 的 endpoint |
| `setup attestation-signer` | `descriptors/*.json` | `.data/doge-config.toml`、`.data/setup_defaults.toml` |
| `setup bridge-init` | `setup_defaults.toml`、`values/genesis.yaml` | `.data/protocol_context.json`、`GenerateBridgeInfo.toml`、`output-withdrawal-processor.toml` |
| `setup gen-secrets` | doge-config、bridge-init 产物 | `secrets/withdrawal-processor-secret.env` 等 |
| `setup prep-charts` | `config.toml`、doge-config、contracts | `values/*-production.yaml`、`WithdrawalProcessor.toml` managed 块、`tsoSigners` |
| `setup proof-aws-init` | 两个 proof values 文件 | S3/IRSA/secret（云端）+ 回写两个 values |
| `setup proof-config` | production: `proof-artifacts/`；两种模式：两个 K8s values 与 WP 部署配置 | 两个 values、两个 TOML 的标记块；mock 另写 `prover-worker-mock/docker-compose/` |
| `setup export-signer-policy` | doge-config、`protocol_context.json` + `.protocol_id`、`config.toml`、`setup_defaults.toml`、WP/coordinator TOML；production 另读固定的 `configs/source-set.toml` | `signer-policy-bundle/`（verifier registry 从 proof triples 生成；mock source set 自动生成为空；含带真实地址/命令的 `PARTNER-COMMANDS.md`，发给全体 signer 运营方） |
| `setup push-secrets` | `secrets/*.env` | 云端 Secrets Manager + values 的 externalSecrets 接线 |

## 10. 排错要点

- 错误码：descriptor 导入失败 `E801`，policy 导出失败 `E804`，proof-config
  失败 `E701`，proof-aws-init 失败 `E710`；通用错误码表见 `docs/automation.md`。
- `setup attestation-signer` 报 `setup_defaults.toml not found` → 先跑
  `setup doge-config`。
- `export-signer-policy` 报 no external attestation signers → doge-config 的
  `attestationSigner.mode` 不是 `external`，先跑 descriptor 导入。
- `export-signer-policy` 报 `protocol_context.protocol_id not found` →
  bridge-init 用的 dogeos-core 镜像太旧（没有 protocol_id sidecar），换新镜像
  重跑 `--step 5-protocol-context`（幂等），或手动传 `--protocol-instance-id`。
- `export-signer-policy` 报 no staged signer proof-artifact base URL → 还没跑
  `setup proof-config`；先跑 ⑨。非标准迁移场景才手动传该命令的
  `--signer-proof-artifact-base-url` 覆盖值。
- `proof-aws-init` 报 values file not found → 先跑 `setup prep-charts`。
- `proof-config` fail-closed 报某个 materializer 键 → `ProofCoordinator.toml`
  的手工维护段不完整（`[materializer.bridge.*]`、
  `[materializer.scroll_batch.subprocess.ethereum_da]` 等），CLI 不会替你发明
  部署选择。
- signer 侧健康检查：`curl http://localhost:4040/health` 应返回与 descriptor
  一致的 `public_key`；`--probe` 只是交叉验证，descriptor 始终是权威。
- 密钥纪律：一个 signer id = 一把 key = 一家运营方；轮换是与桥运营方协同的
  RotateKey ceremony，不是重发 descriptor。
