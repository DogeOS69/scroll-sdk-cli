# DogeOS 核心服务配置 Runbook（中文）

本页将旧 partner-attestation-signer 分支的服务说明更新到当前 CLI。
完整命令顺序以 [setup order](setup-order.md) 为准；proof 发布以
[proof configuration transactions](proof-config-transactions.md) 为准。
旧版 `setup proof-config --mode mock/production` 和独立 Geth
`deployment-state.yaml` 流程不适用于当前版本。

## 配置目录与服务职责

在仓库之外建立部署目录。`config.toml` 保存部署账号及 contracts 输入，
`.data/doge-config.toml` 保存 Reth、DA、signer 和 proof 的配置。
密钥、CubeSigner session、云凭证和生成的 Secret 文件留在部署目录或外部
Secret 管理服务中；示例中的 `$ENV:VAR_NAME` 表示运行时环境变量引用。

| 服务 | 职责与依赖 |
| --- | --- |
| Reth | L2 执行；节点密钥和 sequencer signer 来自 doge-config。 |
| eth-da-submitter | Ethereum DA 提交与归档；使用独立的服务签名身份。 |
| withdrawal-processor | 处理提现、调用 proof/attestation 服务；依赖当前 Bridge 与 protocol context。 |
| proof-coordinator | 调度证明和材料；mock generation 在进程内生成 mock proof。 |
| prover-worker | real generation 的独立 Worker；镜像身份必须与所选 release 和 bake 相符。 |
| attestation-signer | 合作方运营的证据校验和签名服务；合作方负责其 RPC quorum 与轮换策略。 |
| tso-service | 登记 attestation/transport 公钥，接受外部 signer 主动发起的签名 poll 和回调；不主动连接这些外部 signer。 |

## 身份与 Bridge 前置准备

先配置 Dogecoin RPC、Ethereum DA 和域名，再准备服务身份。统一入口为：

```bash
scrollsdk setup gen-keystore --accounts -N
scrollsdk setup gen-keystore --service sequencer-reth --index 0 -N
scrollsdk setup gen-keystore --service bootnode-reth --bootnode-count 1 -N
scrollsdk setup gen-keystore --service fee-oracle -N
scrollsdk setup gen-keystore --service eth-da-submitter -N
```

这些命令使用已声明的配置；新 AWS KMS 身份还需要 region、EKS cluster 等
参数。按需增加 `--activity-helper`。重跑保留已有身份；不要用旧分支的
Geth keystore 或强制重新生成流程覆盖现有 Reth 身份。
详见 [keystore](keystore.md)。

合作方在自己的运行环境完成 `signer init`、`--print-identity`、
`signer init --identity`，生成包含 attestation 和 transport 公钥的公开
descriptor。beta.6 使用 pull delivery，signer 主动连接 TSO；无需提供 signer
endpoint，也无需开放入站签名端口。桥运营方收集 descriptor 后执行
`scrollsdk setup attestation-signer`，在 Bridge 创世前确定初始 keyset。
Partner kit 的 `4040`（本机 preflight）和 `9100`（本机 metrics）默认仅绑定
`127.0.0.1`；远程监控是独立的可选私网配置。验收时检查本机 readiness、
TSO 收到的 poll 和签名回调，不再从 TSO 网络探测 signer HTTP。
`signer init --force` 会为 local backend 生成新密钥；保留身份的重跑不要加它。

完成账户、signer、CubeSigner 配置后，执行 `setup gen-l2-artifacts`，再按
[setup order](setup-order.md) 的 Bridge 阶段逐步执行。genesis 生成仍检查
owner 和 index-0 Reth signer；protocol context 必须来自当前实例。
既有实例的日常配置更新不应重建 genesis 或 Bridge。

## Proof 材料与配置

当前 release manifest 使用 `schema`、`revision` 和五个 digest 固定的镜像：
producer、CUDA Worker、coordinator、topology compiler、publisher。
`mode`、`generation`、`enforcement` 分别控制拓扑、证明生成及校验策略，
不能再用旧版单个 mock/production 参数代替。

1. 配置共享 artifact store 与 `setup proof-aws-init` 的读取方式。已有共享桶
   使用 `existing-public-s3` 或 `existing-gateway`；需要补充权限时，通过
   `setup artifact-access` 先查看计划，再显式使用 `--apply`。
2. 按 [proof configuration transactions](proof-config-transactions.md) 准备
   request、release manifest 和 SHA-256，运行 `setup proof-config prepare`。
   real 和 release mock 都使用 producer bake 的身份；materializer 从匹配的
   coordinator 镜像提取。
3. 检查生成目录中的配置、收据及发布计划。real generation 还需通过 CUDA
   Worker 身份检查；mock generation 不生成 Worker 部署契约。
4. `setup proof-config publish` 的预览不会写入 S3；发布材料需要显式 `--apply`。
   这一步不代表服务部署或真实 GPU 证明验收完成。

诊断和单步操作见 [proof release workflow](proof-release-workflow.md)。
公开 artifact 读取不包含 signer session、RPC 密码或 proof bearer token。

## 渲染、signer 交接与部署

使用 `setup prep-charts` 生成与当前配置对应的 values、原生配置和 proof
deployment contract，再运行 `setup export-signer-policy` 生成合作方交接包。
导出时会核对当前 intent 和 contract；配置有变化时先重新生成。

合作方校验并应用交接包，同时保留自己审阅的 `attestation-signer.toml`。
enforce 模式的各 RPC source set 使用至少两个独立 trust domain 的 quorum；
`explicit_single_source` 仅用于 observe。分别验证 signer 到依赖服务、TSO
到 signer 的网络路径，不能用操作员笔记本上的成功请求替代容器网络检查。

`setup gen-secrets` 生成所需本地 Secret 文件，`setup push-secrets` 发布到
选定的外部 Secret 服务或 Kubernetes。随后使用当前 SDK 的 Helm/Makefile
流程部署已选择的服务。配置、发布和部署检查见
[deployment preflight](deployment-preflight.md)。

dstack 的凭证、PostgreSQL/SQLite、监控和上传范围见
[dstack controller](dstack-controller.md)。Reth 公网 bootnode 与外部 RPC
导出见 [public P2P](bootnode-public-p2p.md)。

## 验收边界

构建、单元测试、镜像 label 检查和材料发布不能替代实际提现验收。运行中的
验收应覆盖提现、材料读取、证明或 mock 证明、合作方签名以及最终结算，并记录
所用 release、protocol context、配置收据和运行网络。切换 real/enforce 前
按所选部署的运行手册完成独立验证。
