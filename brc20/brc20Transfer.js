#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Logger = require('@youpaichris/logger');
const { bitcoin } = require('@unisat/wallet-sdk/lib/bitcoin-core');
const { wallet } = require('@unisat/wallet-sdk');
const { AddressType } = require('@unisat/wallet-sdk/lib/types');
const { NetworkType } = require('@unisat/wallet-sdk/lib/network');
const { createSendOrd } = require('@unisat/ord-utils');
const {
    buildInscriptionScript,
    estimateRevealVSize,
    buildRevealTransaction,
    wait,
    createCommitTx,
    ensureDir,
    selectUtxos,
    broadcastTransaction,
} = require('./lib/brc20');
const { getTxStatus } = require('../btcUtils');

dotenv.config();
const logger = new Logger();

const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const configPathIndex = argv.indexOf('--config');
const customConfigPath = configPathIndex !== -1 ? argv[configPathIndex + 1] : null;
const stepArgIndex = argv.indexOf('--step');
const stepArg = stepArgIndex !== -1 ? argv[stepArgIndex + 1] : null;
const pendingArgIndex = argv.indexOf('--pending');
const pendingArg = pendingArgIndex !== -1 ? argv[pendingArgIndex + 1] : null;
const CONFIG_PATH = customConfigPath ? path.resolve(customConfigPath) : path.resolve(__dirname, 'configs/brc20.transfer.json');

let fileConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
    try {
        fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        logger.warn(`读取 ${CONFIG_PATH} 失败: ${error.message}`);
    }
}

const MODE = (process.env.BRC20_TRANSFER_MODE || fileConfig.MODE || 'fanout').toLowerCase();
const STEP = (stepArg || process.env.BRC20_TRANSFER_STEP || fileConfig.BRC20_TRANSFER_STEP || 'prepare').toLowerCase();
const STEP_CHOICES = new Set(['prepare', 'send', 'auto']);
if (!STEP_CHOICES.has(STEP)) {
    logger.error(`无效的 step 参数: ${STEP}，可选值为 prepare | send | auto`);
    process.exit(1);
}
const isPrepareStep = STEP === 'prepare';
const isSendStep = STEP === 'send';
const isAutoStep = STEP === 'auto';

const requiredEnvKeys = new Set(['BRC20_TICK']);
if (MODE !== 'collect' || isSendStep || isAutoStep) {
    requiredEnvKeys.add('MAIN_WALLET_MNEMONIC');
}
const REQUIRED_ENV = Array.from(requiredEnvKeys);
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key] && !fileConfig[key]);
if (missingEnv.length && !isDryRun) {
    logger.error(`缺少必要配置: ${missingEnv.join(', ')}`);
    process.exit(1);
}

const MAIN_WALLET_MNEMONIC = process.env.MAIN_WALLET_MNEMONIC || fileConfig.MAIN_WALLET_MNEMONIC || '';
const TICK = (process.env.BRC20_TICK || fileConfig.BRC20_TICK || '').trim();
const CONTENT_TYPE = process.env.BRC20_CONTENT_TYPE || fileConfig.BRC20_CONTENT_TYPE || 'text/plain;charset=utf-8';
const FEE_RATE = Number(
    process.env.FEE_RATE
    || fileConfig.FEE_RATE
    || 3
);
const COMMIT_FEE_RATE = FEE_RATE;
const REVEAL_FEE_RATE = FEE_RATE;
const REVEAL_OUTPUT_VALUE = Number(fileConfig.BRC20_REVEAL_OUTPUT_VALUE || 546);
const REVEAL_DELAY = Number(fileConfig.BRC20_REVEAL_DELAY || 3000);
const MAX_RETRY = Number(fileConfig.BRC20_MAX_RETRY || 3);
const RETRY_DELAY = Number(fileConfig.BRC20_RETRY_DELAY || 3000);
function resolveWithDefault(value, defaultRelative) {
    if (value) {
        return path.isAbsolute(value) ? value : path.resolve(value);
    }
    return path.resolve(__dirname, defaultRelative);
}

function resolveOptional(value) {
    if (!value) {
        return '';
    }
    return path.isAbsolute(value) ? value : path.resolve(value);
}

const OUTPUT_DIR = resolveWithDefault(fileConfig.OUTPUT_DIR, 'outputs');
const LOG_DIR = resolveWithDefault(fileConfig.LOG_DIR, 'logs');
const ADDRESS_FILE = path.resolve(fileConfig.TRANSFER_ADDRESS_FILE || path.join(__dirname, 'configs/transfer-address.txt'));
const SUCCESS_LIST_PATH = path.join(OUTPUT_DIR, 'transfer-success.txt');
const FAIL_LIST_PATH = path.join(OUTPUT_DIR, 'transfer-fail.txt');
const SEND_FEE_RATE = FEE_RATE;
const SEND_MAX_RETRY = Number(process.env.BRC20_SEND_MAX_RETRY || fileConfig.BRC20_SEND_MAX_RETRY || MAX_RETRY);
const SEND_RETRY_DELAY = Number(process.env.BRC20_SEND_RETRY_DELAY || fileConfig.BRC20_SEND_RETRY_DELAY || RETRY_DELAY);
const WAIT_CONFIRMATIONS = Number(fileConfig.BRC20_TRANSFER_WAIT_CONFIRMS);
const WAIT_TIMEOUT = Number(fileConfig.BRC20_TRANSFER_WAIT_TIMEOUT || 600000);
const WAIT_POLL_INTERVAL = Number(process.env.BRC20_TRANSFER_WAIT_POLL_INTERVAL || fileConfig.BRC20_TRANSFER_WAIT_POLL_INTERVAL || 30000);
const COLLECT_SOURCE_FILE = resolveOptional(process.env.COLLECT_SOURCE_FILE || fileConfig.COLLECT_SOURCE_FILE || '');
const COLLECT_TARGET_ADDRESS = (process.env.COLLECT_TARGET_ADDRESS || fileConfig.COLLECT_TARGET_ADDRESS || '').trim();
const COLLECT_DEFAULT_AMT = (process.env.COLLECT_DEFAULT_AMT || fileConfig.COLLECT_DEFAULT_AMT || '').trim();
const defaultPendingPath = path.join(OUTPUT_DIR, fileConfig.BRC20_PENDING_FILE || 'transfer-pending.json');
const PENDING_FILE = pendingArg ? path.resolve(pendingArg) : defaultPendingPath;

ensureDir(OUTPUT_DIR);
ensureDir(LOG_DIR);

console.info(`WAIT_CONFIRMATIONS: ${WAIT_CONFIRMATIONS}, fileConfig.BRC20_TRANSFER_WAIT_CONFIRMS : ${fileConfig.BRC20_TRANSFER_WAIT_CONFIRMS}`)
console.info(`FEE_RATE: ${FEE_RATE} | COMMIT_FEE_RATE: ${COMMIT_FEE_RATE} | REVEAL_FEE_RATE: ${REVEAL_FEE_RATE}`);

const { LocalWallet } = wallet;

function loadTransferAddresses(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`找不到转账地址文件: ${filePath}`);
    }
    return fs
        .readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function loadAddressSet(filePath) {
    const set = new Set();
    if (!fs.existsSync(filePath)) {
        return set;
    }
    fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .forEach((line) => set.add(line));
    return set;
}

function appendAddressToFile(filePath, set, address) {
    if (!address || set.has(address)) {
        return;
    }
    fs.appendFileSync(filePath, `${address}\n`, 'utf8');
    set.add(address);
}

function buildTransfersFromAddresses(addresses, successSet) {
    return addresses
        .map((address, idx) => ({ index: idx, address, amt: null }))
        .filter((item) => !successSet.has(item.address));
}

function buildPayload(amount) {
    return {
        p: 'brc-20',
        op: 'transfer',
        tick: TICK,
        amt: String(amount),
    };
}

function encodePayload(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8');
}

function loadCollectSources(filePath, defaultAmt) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`找不到 COLLECT_SOURCE_FILE: ${filePath}`);
    }
    const lines = fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

    return lines.map((line, idx) => {
        const [mnemonicPart, amtPart] = line.split('----');
        const mnemonic = (amtPart ? mnemonicPart : line).trim();
        const amt = (amtPart ? amtPart : defaultAmt).trim();
        if (!mnemonic) {
            throw new Error(`COLLECT_SOURCE_FILE 第 ${idx + 1} 行缺少助记词`);
        }
        if (!amt) {
            throw new Error(`COLLECT_SOURCE_FILE 第 ${idx + 1} 行缺少转账数量，且未配置 COLLECT_DEFAULT_AMT`);
        }
        return {
            mnemonic,
            amt,
            index: idx,
        };
    });
}

function loadPendingRecords(successFilter = new Set()) {
    if (!fs.existsSync(PENDING_FILE)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(PENDING_FILE, 'utf8');
        if (!raw.trim()) {
            return [];
        }
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.filter((item) => item && !successFilter.has(item.address));
        }
        logger.warn(`忽略损坏的 pending 文件: ${PENDING_FILE}`);
    } catch (error) {
        logger.warn(`读取 pending 文件失败: ${error.message}`);
    }
    return [];
}

function persistPendingRecords(records) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(records, null, 2), 'utf8');
}

function upsertPendingRecord(records, record) {
    const filtered = records.filter((item) => item.ordinalId !== record.ordinalId);
    filtered.push(record);
    return filtered;
}

function dropPendingRecord(records, ordinalId) {
    return records.filter((item) => item.ordinalId !== ordinalId);
}

async function processSendQueue({ wallet, records, successSet, onSuccess, onFail }) {
    if (isDryRun) {
        throw new Error('send 步骤不支持 dry-run');
    }

    let pending = [...records];
    const sendResults = [];

    for (const record of records) {
        if (!record?.revealTxId) {
            logger.warn(`跳过缺少 revealTxId 的记录: ${JSON.stringify(record)}`);
            pending = dropPendingRecord(pending, record.ordinalId || `${record.revealTxId}i${record.revealVout ?? 0}`);
            continue;
        }
        if (successSet.has(record.address)) {
            pending = dropPendingRecord(pending, record.ordinalId || `${record.revealTxId}i${record.revealVout ?? 0}`);
            continue;
        }
        try {
            if (WAIT_CONFIRMATIONS > 0) {
                await waitForConfirmations(record.revealTxId, WAIT_CONFIRMATIONS);
            }
            const sendInfo = await sendPreparedTransfer({ wallet, record });
            const enriched = {
                ...record,
                sendTxId: sendInfo.sendTxId,
                sendFee: sendInfo.fee,
                status: 'sent',
            };
            sendResults.push(enriched);
            pending = dropPendingRecord(pending, record.ordinalId || `${record.revealTxId}i${record.revealVout ?? 0}`);
            onSuccess?.(record.address);
            fs.appendFileSync(
                path.join(LOG_DIR, 'transfer-send.log'),
                `${JSON.stringify({ ordinalId: enriched.ordinalId || `${record.revealTxId}i${record.revealVout ?? 0}`, sendTxId: sendInfo.sendTxId, fee: sendInfo.fee, address: record.address, amt: record.amt })}\n`,
                'utf8',
            );
            await wait(1000);
        } catch (error) {
            const reason = error?.message || String(error);
            const message = `转账至 ${record.address} 失败：${reason}`;
            logger.error(`[${record.label || record.address}] send 失败：${reason}`);
            onFail?.(record.address);
            const wrapped = new Error(message);
            wrapped.remaining = pending;
            throw wrapped;
        }
    }

    return { results: sendResults, remaining: pending };
}

async function waitForConfirmations(txid, requiredConfirmations) {
    if (requiredConfirmations <= 0) {
        return { confirmed: false };
    }
    logger.info(`等待交易 ${txid} 达到 ${requiredConfirmations} 个确认`);
    const start = Date.now();
    while (Date.now() - start <= WAIT_TIMEOUT) {
        try {
            const detail = await getTxStatus(txid);
            const confirmed = !!detail?.status?.confirmed;
            if (confirmed) {
                logger.success(`交易 ${txid} 已确认`);
                return { confirmed: true };
            }
        } catch (error) {
            logger.warn(`查询交易状态失败: ${error.message}`);
        }
        await wait(WAIT_POLL_INTERVAL);
    }
    throw new Error(`交易 ${txid} 在 ${WAIT_TIMEOUT / 1000}s 内未确认`);
}

async function sendPreparedTransfer({ wallet, record, extraUtxos = [] }) {
    if (isDryRun) {
        throw new Error('send 步骤暂不支持 dry-run');
    }

    const ordId = record.ordinalId || `${record.revealTxId}i${record.revealVout ?? 0}`;
    const revealOutputValue = record.revealOutputValue || REVEAL_OUTPUT_VALUE;
    logger.warn(
        `\n>>>>>>>>>>>> send 阶段开始 <<<<<<<<<<<<\n` +
        `目标地址: ${record.address}\n` +
        `铭文 ID : ${ordId}`
    );

    const ordUtxo = {
        txId: record.revealTxId,
        txid: record.revealTxId,
        outputIndex: record.revealVout ?? 0,
        vout: record.revealVout ?? 0,
        value: revealOutputValue,
        satoshis: revealOutputValue,
        scriptPk: wallet.scriptPk,
        addressType: wallet.addressType,
        pubkey: wallet.pubkey,
        address: wallet.address,
        ords: [{ id: ordId, offset: 0 }],
        inscriptions: [],
        atomicals: [],
    };

    const fundingUtxos = await selectUtxos(wallet).catch((error) => {
        logger.warn(`获取额外UTXO失败: ${error.message}`);
        return [];
    });

    const usableFunding = fundingUtxos.filter((item) => item.txid !== record.revealTxId || item.vout !== (record.revealVout ?? 0));

    if (record.changeAmount && record.changeAmount >= 546) {
        usableFunding.unshift({
            txId: record.revealTxId,
            txid: record.revealTxId,
            outputIndex: record.changeVout ?? 1,
            vout: record.changeVout ?? 1,
            value: record.changeAmount,
            satoshis: record.changeAmount,
            scriptPk: wallet.scriptPk,
            addressType: wallet.addressType,
            pubkey: wallet.pubkey,
            address: wallet.address,
            ords: [],
            inscriptions: [],
            atomicals: [],
        });
    }

    extraUtxos.forEach((item) => {
        if (!usableFunding.find((u) => u.txid === item.txid && u.vout === item.vout)) {
            usableFunding.push(item);
        }
    });

    const utxosForSend = [ordUtxo, ...usableFunding];
    logger.info(`[${record.label}] send 阶段使用 ${utxosForSend.length} 枚 UTXO 构建交易`);

    const psbt = await createSendOrd({
        utxos: utxosForSend,
        toAddress: record.address,
        toOrdId: ordId,
        wallet,
        network: bitcoin.networks.bitcoin,
        changeAddress: wallet.address,
        pubkey: wallet.pubkey,
        feeRate: SEND_FEE_RATE,
        outputValue: revealOutputValue,
        dump: false,
        enableRBF: true,
    });

    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();
    const sendTxId = tx.getId();

    for (let attempt = 1; attempt <= SEND_MAX_RETRY; attempt++) {
        try {
            await broadcastTransaction(txHex);
            break;
        } catch (error) {
            const detail = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
            logger.error(`[${record.label}] transfer 广播失败(${attempt}/${SEND_MAX_RETRY}): ${detail}`);
            if (attempt === SEND_MAX_RETRY) {
                throw error;
            }
            await wait(SEND_RETRY_DELAY * attempt);
        }
    }

    logger.success(`[${record.label}] 已广播 transfer 交易: ${sendTxId}`);


    const totalInput = utxosForSend.reduce((sum, item) => sum + (item.satoshis || item.value || 0), 0);
    const totalOutput = tx.outs.reduce((sum, out) => sum + out.value, 0);
    const fee = totalInput - totalOutput;
    logger.warn(
        `手续费: ${fee} sats\n` +
        `<<<<<<<<<<<< send 阶段结束 <<<<<<<<<<<<\n`
    );

    return {
        sendTxId,
        fee,
        ordId,
        inputs: utxosForSend.map((item) => ({ txid: item.txid, vout: item.vout, satoshis: item.satoshis || item.value || 0 })),
    };
}

async function prepareTransfer({ wallet, transfer, amount, utxo, label = '' }) {
    const payload = buildPayload(amount);
    const bodyBuffer = encodePayload(payload);
    const { script, payment } = buildInscriptionScript(wallet.pubkey, CONTENT_TYPE, bodyBuffer);

    if (!payment.address || !payment.output) {
        throw new Error('无法构建 commit 地址');
    }

    const changeAddress = wallet.address;
    const utxoValue = utxo ? (utxo.satoshis || utxo.value || 0) : REVEAL_OUTPUT_VALUE + 100000;
    if (!utxo && !isDryRun) {
        throw new Error('缺少可用UTXO');
    }

    const baseVSize = estimateRevealVSize(payment, script, wallet.address, REVEAL_OUTPUT_VALUE, 0, changeAddress);
    let revealFee = Math.ceil(baseVSize * REVEAL_FEE_RATE);
    const commitFeeReserve = Math.max(300, Math.ceil((150) * COMMIT_FEE_RATE));
    let commitTarget = utxoValue - commitFeeReserve;
    if (commitTarget <= REVEAL_OUTPUT_VALUE + revealFee) {
        commitTarget = utxoValue - Math.max(100, COMMIT_FEE_RATE * 50);
    }
    if (commitTarget <= REVEAL_OUTPUT_VALUE + revealFee) {
        throw new Error(`[${label}] 可用余额不足以覆盖铭文输出`);
    }

    logger.warn(
        `\n============= 开始处理 ${label} =============\n` +
        `目标地址: ${transfer.address}\n` +
        `铭文数量: ${amount}\n` +
        `预估 reveal 手续费: ~${revealFee} sats\n` +
        `预估 commit 输出: ${commitTarget} sats\n` +
        `-------------------------------------------`
    );

    if (isDryRun) {
        return {
            address: transfer.address,
            amt: amount,
            commitAddress: payment.address,
            commitAmount: commitTarget,
            revealFee,
            revealVSize: baseVSize,
            changeAmount: Math.max(commitTarget - REVEAL_OUTPUT_VALUE - revealFee, 0),
            changeAddress,
            inscriptionAddress: wallet.address,
        };
    }

    let commitHex;
    let attempts = 0;
    while (!commitHex) {
        try {
            commitHex = await createCommitTx(wallet, payment.address, commitTarget, COMMIT_FEE_RATE, utxo ? [utxo] : null);
        } catch (error) {
            attempts += 1;
            if (attempts >= MAX_RETRY || !error.message?.includes('Balance not enough')) {
                throw error;
            }
            commitTarget -= Math.max(100, COMMIT_FEE_RATE * 50);
            logger.warn(`[${label}] 调整 commit 输出为 ${commitTarget} sats 重试`);
            if (commitTarget <= REVEAL_OUTPUT_VALUE + revealFee) {
                throw new Error(`[${label}] 可用余额不足以覆盖铭文输出`);
            }
        }
    }

    const commitTx = bitcoin.Transaction.fromHex(commitHex);
    const commitTxId = commitTx.getId();
    const commitVout = commitTx.outs.findIndex((out) => out.script.equals(payment.output));
    if (commitVout === -1) {
        throw new Error('未找到commit输出');
    }
    const commitValue = commitTx.outs[commitVout].value;

    let changeAmount = Math.max(commitValue - REVEAL_OUTPUT_VALUE - revealFee, 0);
    if (changeAmount > 0 && changeAmount < 546) {
        changeAmount = 0;
    }

    for (let i = 0; i < 3; i++) {
        const vSize = estimateRevealVSize(payment, script, wallet.address, REVEAL_OUTPUT_VALUE, changeAmount, changeAddress);
        const fee = Math.ceil(vSize * REVEAL_FEE_RATE);
        const possibleChange = Math.max(commitValue - REVEAL_OUTPUT_VALUE - fee, 0);
        const normalizedChange = possibleChange >= 546 ? possibleChange : 0;
        if (normalizedChange === changeAmount && fee === revealFee) {
            revealFee = fee;
            break;
        }
        revealFee = fee;
        changeAmount = normalizedChange;
    }

    if (commitValue < REVEAL_OUTPUT_VALUE + revealFee) {
        throw new Error(`[${label}] commit 输出不足以覆盖铭文输出和手续费`);
    }

    const reveal = await buildRevealTransaction({
        wallet,
        commitTxId,
        commitVout,
        commitValue,
        script,
        payment,
        receiveAddress: wallet.address,
        revealOutputValue: REVEAL_OUTPUT_VALUE,
        changeAddress,
        changeAmount,
    });

    logger.info(`[${label}] commit 交易 ${commitTxId}，预计 reveal 费用 ${reveal.fee} sats（vsize=${reveal.vsize}）`);
    // if (changeAmount > 0) {
    //     logger.info(`[${label}] 最终找零 ${changeAmount} sats -> ${changeAddress}`);
    // }

    await broadcastTransaction(commitHex);
    logger.success(`[${label}] 已广播 commit: ${commitTxId}`);

    if (REVEAL_DELAY > 0) {
        logger.info(`等待 ${REVEAL_DELAY}ms 后广播 reveal`);
        await wait(REVEAL_DELAY);
    }
    let revealTxId = '';
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            revealTxId = await broadcastTransaction(reveal.hex);
            break;
        } catch (err) {
            const detail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
            logger.error(`reveal 广播失败(${attempt}/${MAX_RETRY}): ${detail}`);
            if (attempt === MAX_RETRY) throw err;
            await wait(RETRY_DELAY * attempt);
        }
    }
    logger.success(`[${label}] 已广播 reveal: ${revealTxId}`);

    const ordinalId = `${revealTxId}i0`;
    const record = {
        tick: TICK,
        address: transfer.address,
        amt: amount,
        commitTxId,
        revealTxId,
        commitAmount: commitValue,
        revealFee: reveal.fee,
        changeAmount,
        changeAddress,
        revealOutputValue: REVEAL_OUTPUT_VALUE,
        revealVout: 0,
        changeVout: changeAmount > 0 ? 1 : null,
        ordinalId,
        label,
        createdAt: Date.now(),
        status: 'prepared',
    };

    fs.appendFileSync(path.join(LOG_DIR, 'transfer-success.log'), `${JSON.stringify(record)}\n`, 'utf8');

    logger.success(`[${label}] 铭刻完成，ordinal ${ordinalId} 已生成`);
    logger.warn(
        `============= 完成 ${label} =============\n` +
        `已生成铭文: ${ordinalId}\n` +
        `commit tx: ${commitTxId}\n` +
        `reveal tx: ${revealTxId}\n` +
        `-------------------------------------------\n`
    );

    return record;
}

async function main() {
    logger.warn('BRC2.0 铭文转账脚本启动');
    logger.info(`dryRun=${isDryRun}，mode=${MODE}，step=${STEP}`);

    if (isSendStep && isDryRun) {
        logger.error('send 步骤不支持 dry-run');
        return;
    }

    if (MODE === 'collect') {
        if (isSendStep || isAutoStep) {
            throw new Error('collect 模式暂未实现 send/auto 步骤');
        }
        if (!COLLECT_SOURCE_FILE) {
            throw new Error('COLLECT_SOURCE_FILE 未配置');
        }
        if (!COLLECT_TARGET_ADDRESS) {
            throw new Error('COLLECT_TARGET_ADDRESS 未配置');
        }

        const sources = loadCollectSources(COLLECT_SOURCE_FILE, COLLECT_DEFAULT_AMT);
        if (!sources.length) {
            logger.warn('未在 COLLECT_SOURCE_FILE 中找到有效记录');
            return;
        }

        logger.info(`共 ${sources.length} 个来源钱包，目标地址 ${COLLECT_TARGET_ADDRESS}`);

        const results = [];
        for (const source of sources) {
            const sourceWallet = LocalWallet.fromMnemonic(AddressType.P2TR, NetworkType.MAINNET, source.mnemonic, '', "m/86'/0'/0'/0");
            const label = `collect-${source.index + 1}`;
            const transfer = { address: COLLECT_TARGET_ADDRESS, amt: source.amt };
            const sourceUtxos = isDryRun ? [] : await selectUtxos(sourceWallet);
            const utxo = isDryRun ? null : sourceUtxos.shift();
            if (!utxo && !isDryRun) {
                logger.error(`[${label}] ${sourceWallet.address} 无可用UTXO，跳过`);
                fs.appendFileSync(path.join(LOG_DIR, 'transfer-failed.log'), `${label},${sourceWallet.address},no utxo\n`, 'utf8');
                continue;
            }

            try {
                const res = await prepareTransfer({ wallet: sourceWallet, transfer, amount: source.amt, utxo, label });
                res.sourceAddress = sourceWallet.address;
                results.push(res);
            } catch (error) {
                logger.error(`[${label}] 转账失败：${error.message}`);
                fs.appendFileSync(path.join(LOG_DIR, 'transfer-failed.log'), `${label},${sourceWallet.address},${error.message}\n`, 'utf8');
            }

            if (!isDryRun) {
                await wait(1000);
            }
        }

        const summaryPath = path.join(OUTPUT_DIR, isDryRun ? 'transfer-collect-dryrun.json' : 'transfer-collect-summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');
        logger.success(`归集模式完成，详情参见 ${summaryPath}`);
        return;
    }

    const mnemonic = (MAIN_WALLET_MNEMONIC || '').trim();
    const hasMnemonic = mnemonic.length > 0;

    if (!isDryRun && !hasMnemonic) {
        throw new Error('MAIN_WALLET_MNEMONIC 未配置');
    }

    const wallet = hasMnemonic
        ? LocalWallet.fromMnemonic(AddressType.P2TR, NetworkType.MAINNET, mnemonic, '', "m/86'/0'/0'/0")
        : LocalWallet.fromRandom(AddressType.P2TR, NetworkType.MAINNET);

    if (isDryRun && !hasMnemonic) {
        logger.warn('dry-run 模式未提供助记词，使用随机钱包仅用于费用估算');
    }

    const globalAmt = (process.env.BRC20_TRANSFER_AMT || fileConfig.BRC20_TRANSFER_AMT || '').trim();
    const successSet = loadAddressSet(SUCCESS_LIST_PATH);
    const failSet = loadAddressSet(FAIL_LIST_PATH);
    let pendingRecords = loadPendingRecords(successSet);
    const addresses = loadTransferAddresses(ADDRESS_FILE);
    const transfers = buildTransfersFromAddresses(addresses, successSet);
    const appendSuccessAddress = (address) => appendAddressToFile(SUCCESS_LIST_PATH, successSet, address);
    const appendFailAddress = (address) => appendAddressToFile(FAIL_LIST_PATH, failSet, address);

    if (isSendStep) {
        if (!pendingRecords.length) {
            logger.warn('没有待发送的转账记录，请先执行 prepare/auto 步骤');
            return;
        }
        try {
            const { results: sendResults, remaining } = await processSendQueue({
                wallet,
                records: pendingRecords,
                successSet,
                onSuccess: appendSuccessAddress,
                onFail: appendFailAddress,
            });
            pendingRecords = remaining;
            const summaryName = 'transfer-send-summary.json';
            const summaryPath = path.join(OUTPUT_DIR, summaryName);
            fs.writeFileSync(summaryPath, JSON.stringify(sendResults, null, 2), 'utf8');
            if (!isDryRun) {
                persistPendingRecords(pendingRecords);
            }
            logger.success(`send 步骤完成，详情参见 ${summaryPath}`);
        } catch (error) {
            pendingRecords = error?.remaining || pendingRecords;
            if (!isDryRun) {
                persistPendingRecords(pendingRecords);
            }
            throw error;
        }
        return;
    }

    if (!transfers.length) {
        logger.warn('没有有效的转账任务。');
        return;
    }

    logger.info(`共 ${transfers.length} 笔转账`);

    const utxos = isDryRun ? [] : await selectUtxos(wallet);
    utxos.sort((a, b) => (b.satoshis || b.value || 0) - (a.satoshis || a.value || 0));

    const prepareResults = [];
    const sendResults = [];
    let encounteredError = false;
    let failureAddress = '';
    let failureReason = '';

    for (const transfer of transfers) {
        const amount = globalAmt || transfer.amt;
        if (!amount) {
            throw new Error(`转账至 ${transfer.address} 缺少数量：请配置 BRC20_TRANSFER_AMT`);
        }
        const utxo = isDryRun ? null : utxos.shift();
        if (!utxo && !isDryRun) {
            throw new Error('可用UTXO不足，无法继续提交转账');
        }

        let record;
        try {
            record = await prepareTransfer({ wallet, transfer, amount, utxo, label: `fanout-${transfer.index ?? prepareResults.length + 1}` });
            prepareResults.push(record);
            if (!isDryRun) {
                pendingRecords = upsertPendingRecord(pendingRecords, record);
            }
        } catch (error) {
            logger.error(`转账至 ${transfer.address} 失败：${error.message}`);
            if (!isDryRun) {
                appendFailAddress(transfer.address);
            }
            logger.warn(`!!! ${label} 失败，流程终止`);
            encounteredError = true;
            failureAddress = transfer.address;
            failureReason = error.message;
            break;
        }

        if (!isDryRun && isAutoStep) {
            try {
                if (WAIT_CONFIRMATIONS > 0) {
                    await waitForConfirmations(record.revealTxId, WAIT_CONFIRMATIONS);
                }
                const sendInfo = await sendPreparedTransfer({ wallet, record });
                record.sendTxId = sendInfo.sendTxId;
                record.sendFee = sendInfo.fee;
                record.status = 'sent';
                sendResults.push({ ...record });
                pendingRecords = dropPendingRecord(pendingRecords, record.ordinalId);
                appendSuccessAddress(record.address);
                fs.appendFileSync(
                    path.join(LOG_DIR, 'transfer-send.log'),
                    `${JSON.stringify({ ordinalId: record.ordinalId, sendTxId: sendInfo.sendTxId, fee: sendInfo.fee, address: record.address, amt: record.amt })}\n`,
                    'utf8',
                );
            } catch (error) {
                record.status = 'prepared';
                logger.error(`[${record.label}] 自动发送失败：${error.message}`);
                appendFailAddress(record.address);
                logger.warn(`!!! ${record.label} 自动发送失败，流程终止`);
                encounteredError = true;
                failureAddress = record.address;
                failureReason = error.message;
                break;
            }
        }

        if (!isDryRun) {
            await wait(1000);
        }
    }

    const summaryName = isDryRun ? `transfer-${STEP}-dryrun.json` : `transfer-${STEP}-summary.json`;
    const summaryPath = path.join(OUTPUT_DIR, summaryName);
    const summaryPayload = isAutoStep ? { prepares: prepareResults, sends: sendResults } : prepareResults;
    fs.writeFileSync(summaryPath, JSON.stringify(summaryPayload, null, 2), 'utf8');
    if (!isDryRun) {
        persistPendingRecords(pendingRecords);
    }
    if (encounteredError) {
        throw new Error(`转账至 ${failureAddress} 失败：${failureReason}`);
    }
    logger.success(`脚本完成，详情参见 ${summaryPath}`);
}

main().catch((err) => {
    logger.error(`脚本异常：${err.message}`);
    if (!isDryRun) {
        process.exit(1);
    }
});
