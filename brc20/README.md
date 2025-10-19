# BRC20 脚本使用说明

本目录提供两个脚本，分别用于 **BRC-20 铭刻 (mint)** 与 **BRC-20 转账 (transfer)**：

- `brc20Inscribe.js`：批量铭刻 `{"op":"mint"}`，生成新的代币额度。
- `brc20Transfer.js`：基于现有余额铭刻 `{"op":"transfer"}` 并发送到目标地址，支持 fanout（1→N）与 collect（N→1）。

所有配置与运行产物默认位于 `brc20/configs/` 与 `brc20/outputs/`，日志保存在 `brc20/logs/`。

## 1. 准备环境

1. 安装依赖：`npm install`
2. 复制示例配置：
   ```bash
   cp brc20/configs/brc20.mint.sample.json brc20/configs/brc20.mint.json
   cp brc20/configs/brc20.transfer.sample.json brc20/configs/brc20.transfer.json
   ```
3. 编辑上述 JSON，至少填写以下字段：
    - `MAIN_WALLET_MNEMONIC`：助记词，脚本默认使用 Taproot (`m/86'/0'/0'/0`) 地址。
    - `BRC20_TICK`：代币标识（必须 4 字符以内，区分大小写）。
    - `BRC20_MINT_AMT`（mint）或 `BRC20_TRANSFER_AMT`（transfer）：本次操作的数量。
    - `TRANSFERS`：fanout 模式下的接收地址列表；collect 模式下通过 `COLLECT_SOURCE_FILE` 指定来源助记词文件。

## 2. 手续费与通用配置

- **统一手续费**：`FEE_RATE` 控制 commit / reveal / send 三个阶段，默认回退为 3 sat/vB，可在 `.env` 或配置文件中覆盖。
- `BRC20_REVEAL_OUTPUT_VALUE`：铭文所占的聪数，建议保持在 546~900 之间。
- 日志目录：`LOG_DIR`（默认 `brc20/logs`）。脚本会写入 `mint-success.log`、`transfer-success.log`、`transfer-failed.log` 等文件。

## 3. 铭刻脚本 `brc20Inscribe.js`

### 3.1 Dry-run

```bash
node brc20/brc20Inscribe.js --dry-run
```

脚本只输出费用估算与计划交易，不会广播。未提供助记词时将生成随机地址用于演算。

### 3.2 正式运行

```bash
node brc20/brc20Inscribe.js
```

- 结果文件：`brc20/outputs/mint-summary.json`
- 成功日志：`brc20/logs/mint-success.log`
- 失败日志：`brc20/logs/mint-failed.log`

## 4. 转账脚本 `brc20Transfer.js`

转账需要两步：先 **prepare** 铭刻 `transfer`，再 **send** 花出该铭文。脚本提供三种模式：

1. `--step prepare`：只铭刻 transfer，产物会写入 `brc20/outputs/transfer-summary.json` 和 `brc20/outputs/transfer-pending.json`。
2. `--step send`：读取 pending 文件，逐条广播 send 交易。
3. `--step auto`：先 prepare，再按 `BRC20_TRANSFER_WAIT_CONFIRMS/TIMEOUT/POLL_INTERVAL` 的策略等待确认并自动 send。

### 4.1 Fanout（默认）

配置文件只需提供 `TRANSFERS`，每项为接收地址（若想为单条指定不同数量，可写成对象 `{ "address": "addr", "amt": "1000" }`）。

```bash
# 仅准备铭刻
node brc20/brc20Transfer.js --step prepare

# 待确认后手动发送
node brc20/brc20Transfer.js --step send

# 一次完成（等待 1 个确认，可修改配置）
node brc20/brc20Transfer.js --step auto
```

### 4.2 Collect（N→1）

在配置中设置 `"MODE": "collect"`，并提供 `COLLECT_SOURCE_FILE`。文件格式：每行一个助记词，可在末尾加 `----数量` 覆盖默认 `COLLECT_DEFAULT_AMT`。

示例：
```
mnemonic words ...
mnemonic words ... ---- 5000
```

运行命令与 fanout 类似，但 collect 模式暂不支持 `--step send/auto`，执行后需手动处理 pending。

### 4.3 其他选项

- `--config /path/to/json`：使用自定义配置文件。
- `--pending /path/to/pending.json`：自定义待发送队列文件位置。
- `--dry-run`：仅估算费用（仅对 `prepare` 有意义，`send` 不支持 dry-run）。

### 4.4 输出与日志

- 成功记录：`brc20/logs/transfer-success.log`
- 发送记录：`brc20/logs/transfer-send.log`
- 失败记录：`brc20/logs/transfer-failed.log`
- Pending 队列：`brc20/outputs/transfer-pending.json`

## 5. 常见问题

1. **为什么只有一笔铭刻，没有 send？**
    - 需要在 `prepare` 之后再执行 `--step send`，或者使用 `--step auto` 等待确认后自动发送。

2. **mempool 报 `insufficient fee`？**
    - 增大 `FEE_RATE`，或在命令行临时传入，例如：`FEE_RATE=10 node brc20/brc20Transfer.js --step auto`。

3. **日志太多？**
    - 所有日志都集中在 `brc20/logs/`，可定期清理或在配置中自定义 `LOG_DIR`。

4. **collect 模式 send 失败？**
    - 该模式目前仅输出铭刻结果，需要人工确认并复制 pending 记录到 fanout 模式或其他工具进行 send。

## 6. 辅助信息

- `.env` 支持覆盖任何配置字段（优先级高于 JSON）。
- 所有脚本均会在 dry-run 模式下提示使用随机钱包，不会广播交易。
- 默认使用主网 Taproot 地址；如果需要测试网，请确保相关依赖与 API 改为测试网环境。
- 需要批量生成测试钱包时，可运行：
  ```bash
  node brc20/createWallet.js --count 5
  ```
  结果会追加至 `brc20/configs/btc-wallet.txt`，格式为 `助记词---地址`。

如需更多帮助，可查看 `brc20/outputs/` 下的 JSON 或 `brc20/logs/` 内的日志文件，了解每次运行的详细数据。
