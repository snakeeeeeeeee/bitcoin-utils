#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Logger = require('@youpaichris/logger');
const { bitcoin } = require('@unisat/wallet-sdk/lib/bitcoin-core');
const { wallet } = require('@unisat/wallet-sdk');
const { AddressType } = require('@unisat/wallet-sdk/lib/types');
const { NetworkType } = require('@unisat/wallet-sdk/lib/network');
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

dotenv.config();
const logger = new Logger();

const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const configPathIndex = argv.indexOf('--config');
const customConfigPath = configPathIndex !== -1 ? argv[configPathIndex + 1] : null;
const CONFIG_PATH = customConfigPath ? path.resolve(customConfigPath) : path.resolve(__dirname, 'configs/brc20.mint.json');

let fileConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
    try {
        fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        logger.warn(`读取 ${CONFIG_PATH} 失败: ${error.message}`);
    }
}

const REQUIRED_ENV = ['MAIN_WALLET_MNEMONIC', 'BRC20_TICK', 'BRC20_MINT_AMT'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key] && !fileConfig[key]);
if (missingEnv.length && !isDryRun) {
    logger.error(`缺少必要配置: ${missingEnv.join(', ')}`);
    process.exit(1);
}

const MAIN_WALLET_MNEMONIC = process.env.MAIN_WALLET_MNEMONIC || fileConfig.MAIN_WALLET_MNEMONIC || '';
const MINT_COUNT = Number(process.env.BRC20_MINT_COUNT || fileConfig.BRC20_MINT_COUNT || 1);
const TICK = (process.env.BRC20_TICK || fileConfig.BRC20_TICK || '').trim();
const MINT_AMT = (process.env.BRC20_MINT_AMT || fileConfig.BRC20_MINT_AMT || '').trim();
const CONTENT_TYPE = process.env.BRC20_CONTENT_TYPE || fileConfig.BRC20_CONTENT_TYPE || 'text/plain;charset=utf-8';
const COMMIT_FEE_RATE = Number(process.env.BRC20_COMMIT_FEE_RATE || fileConfig.BRC20_COMMIT_FEE_RATE || process.env.FEE_RATE || 3);
const REVEAL_FEE_RATE = Number(process.env.BRC20_REVEAL_FEE_RATE || fileConfig.BRC20_REVEAL_FEE_RATE || COMMIT_FEE_RATE);
const REVEAL_OUTPUT_VALUE = Number(process.env.BRC20_REVEAL_OUTPUT_VALUE || fileConfig.BRC20_REVEAL_OUTPUT_VALUE || 546);
const REVEAL_DELAY = Number(fileConfig.BRC20_REVEAL_DELAY || 3000);
const MAX_RETRY = Number(process.env.BRC20_MAX_RETRY || fileConfig.BRC20_MAX_RETRY || 3);
const RETRY_DELAY = Number(process.env.BRC20_RETRY_DELAY || fileConfig.BRC20_RETRY_DELAY || 2000);
function resolveWithDefault(value, defaultRelative) {
    if (value) {
        return path.isAbsolute(value) ? value : path.resolve(value);
    }
    return path.resolve(__dirname, defaultRelative);
}

const OUTPUT_DIR = resolveWithDefault(fileConfig.OUTPUT_DIR, 'outputs');
const LOG_DIR = resolveWithDefault(fileConfig.LOG_DIR, 'logs');

ensureDir(OUTPUT_DIR);
ensureDir(LOG_DIR);

const { LocalWallet } = wallet;

function buildPayload() {
    return {
        p: 'brc-20',
        op: 'mint',
        tick: TICK,
        amt: MINT_AMT,
    };
}

function encodePayload(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8');
}

async function inscribeOnce({ wallet, index, receiveAddress }) {
    const payload = buildPayload();
    const bodyBuffer = encodePayload(payload);
    const { script, payment } = buildInscriptionScript(wallet.pubkey, CONTENT_TYPE, bodyBuffer);

    if (!payment.address || !payment.output) {
        throw new Error('无法构建 commit 地址');
    }

    const utxos = isDryRun ? [] : await selectUtxos(wallet);
    const changeAddress = wallet.address;
    const utxoTotal = utxos.length
        ? utxos.reduce((sum, u) => sum + (u.satoshis || u.value || 0), 0)
        : REVEAL_OUTPUT_VALUE + 100000;

    const commitFeeReserve = Math.max(300, Math.ceil((150 + utxos.length * 20) * COMMIT_FEE_RATE));
    let commitTarget = utxoTotal - commitFeeReserve;
    if (commitTarget <= REVEAL_OUTPUT_VALUE) {
        throw new Error('可用余额不足以覆盖铭文输出');
    }

    logger.info(`序号 ${index + 1}: 预计reveal费 ~${Math.ceil(estimateRevealVSize(payment, script, receiveAddress, REVEAL_OUTPUT_VALUE) * REVEAL_FEE_RATE)} sats，commit输出目标 ${commitTarget} sats`);

    if (isDryRun) {
        return {
            payload,
            commitAddress: payment.address,
            commitAmount: commitTarget,
            revealFee: Math.ceil(estimateRevealVSize(payment, script, receiveAddress, REVEAL_OUTPUT_VALUE) * REVEAL_FEE_RATE),
            revealVSize: estimateRevealVSize(payment, script, receiveAddress, REVEAL_OUTPUT_VALUE),
            changeAmount: Math.max(commitTarget - REVEAL_OUTPUT_VALUE, 0),
            changeAddress,
        };
    }

    let commitHex;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            commitHex = await createCommitTx(wallet, payment.address, commitTarget, COMMIT_FEE_RATE, utxos);
            break;
        } catch (error) {
            if (error.message?.includes('Balance not enough')) {
                commitTarget -= Math.max(100, COMMIT_FEE_RATE * 50);
                logger.warn(`调整 commit 输出为 ${commitTarget} sats 重新尝试`);
                if (commitTarget <= REVEAL_OUTPUT_VALUE) {
                    throw new Error('可用余额不足以覆盖铭文输出');
                }
            } else {
                logger.error(`创建commit交易失败（第${attempt}次）：${error.message}`);
                if (attempt === MAX_RETRY) throw error;
                await wait(RETRY_DELAY * attempt);
            }
        }
    }

    if (!commitHex) {
        throw new Error('创建 commit 交易失败');
    }

    const commitTx = bitcoin.Transaction.fromHex(commitHex);
    const commitTxId = commitTx.getId();
    const commitVout = commitTx.outs.findIndex((out) => out.script.equals(payment.output));
    if (commitVout === -1) {
        throw new Error('未找到commit输出');
    }
    const commitValue = commitTx.outs[commitVout].value;

    let changeAmount = Math.max(commitValue - REVEAL_OUTPUT_VALUE, 0);
    let revealFee = 0;
    for (let i = 0; i < 3; i++) {
        const vSize = estimateRevealVSize(payment, script, receiveAddress, REVEAL_OUTPUT_VALUE, changeAmount, changeAddress);
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
        throw new Error('可用余额不足以覆盖铭文输出和手续费');
    }

    const reveal = await buildRevealTransaction({
        wallet,
        commitTxId,
        commitVout,
        commitValue,
        script,
        payment,
        receiveAddress,
        revealOutputValue: REVEAL_OUTPUT_VALUE,
        changeAddress,
        changeAmount,
    });

    logger.info(`commit交易 ${commitTxId}，reveal将消耗费用 ${reveal.fee} sats（vsize=${reveal.vsize}）`);
    if (changeAmount > 0) {
        logger.info(`最终找零 ${changeAmount} sats -> ${changeAddress}`);
    }

    await broadcastTransaction(commitHex);
    logger.success(`已广播 commit: ${commitTxId}`);

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
    logger.success(`已广播 reveal: ${revealTxId}`);

    const record = {
        payload,
        commitTxId,
        revealTxId,
        commitAmount: commitValue,
        revealFee: reveal.fee,
        changeAmount,
        changeAddress,
    };

    fs.appendFileSync(path.join(LOG_DIR, 'mint-success.log'), `${JSON.stringify(record)}\n`, 'utf8');

    return record;
}

async function main() {
    logger.warn('BRC2.0 五字铭文铭刻脚本启动');
    logger.info(`dryRun=${isDryRun}`);

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

    const receiveAddress = fileConfig.RECEIVE_ADDRESS || process.env.BRC20_RECEIVE_ADDRESS || wallet.address;

    logger.info(`使用地址 ${wallet.address}，接收地址 ${receiveAddress}`);

    const results = [];
    for (let i = 0; i < MINT_COUNT; i++) {
        try {
            const res = await inscribeOnce({ wallet, index: i, receiveAddress });
            results.push(res);
            if (!isDryRun) {
                await wait(1000);
            }
        } catch (error) {
            logger.error(`第 ${i + 1} 个铭刻失败：${error.message}`);
            fs.appendFileSync(path.join(LOG_DIR, 'mint-failed.log'), `${i + 1},${error.message}\n`, 'utf8');
            if (!isDryRun) {
                await wait(RETRY_DELAY);
            }
        }
    }

    const summaryPath = path.join(OUTPUT_DIR, isDryRun ? 'mint-dryrun.json' : 'mint-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');
    logger.success(`脚本完成，详情参见 ${summaryPath}`);
}

main().catch((err) => {
    logger.error(`脚本异常：${err.message}`);
    if (!isDryRun) {
        process.exit(1);
    }
});
