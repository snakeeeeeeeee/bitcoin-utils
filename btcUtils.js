const axios = require("axios");
const {HttpsProxyAgent} = require('https-proxy-agent');
const fs = require("fs");
const crypto = require('crypto');
const {Transaction} = require("@unisat/wallet-sdk/lib/transaction");
const {scriptPkToAddress, isValidAddress} = require("@unisat/wallet-sdk/lib/address");
const {bitcoin} = require("@unisat/wallet-sdk/lib/bitcoin-core");
const {AddressType, wallet} = require("@unisat/wallet-sdk");
const LocalWallet = wallet.LocalWallet;
const {NetworkType} = require("@unisat/wallet-sdk/lib/network");
const {createSendBTC, createSendMultiBTC} = require("@unisat/ord-utils");
const bip39 = require('bip39');
const {amountToSaothis, satoshisToAmount} = require("@unisat/ord-utils/lib/utils");


const dotenv = require('dotenv');
dotenv.config();

const PROXY = process.env.PROXY;
const agent = PROXY ? new HttpsProxyAgent(PROXY) : null;

function getWalletFromPrivateKey(privateKey, walletType = AddressType.P2TR) {
    try {
        return new LocalWallet(privateKey, walletType, NetworkType.MAINNET)
    } catch (error) {
        console.error('getWalletFromMnemonic Error', {error, privateKey});
        throw error;
    }
}

function getBitlightWallet(mnemonic, walletType = AddressType.P2TR) {
    try {
        const mainWallet = LocalWallet.fromMnemonic(walletType, NetworkType.MAINNET, mnemonic, '', "m/86'/0'/0'/0")
        const rgbWallet = LocalWallet.fromMnemonic(walletType, NetworkType.MAINNET, mnemonic, '', "m/86'/827166'/0'/0")
        const changeWallet = LocalWallet.fromMnemonic(walletType, NetworkType.MAINNET, mnemonic, '', "m/86'/0'/0'/1")
        return {
            mainWallet,
            changeWallet,
            rgbWallet,
        }
    } catch (error) {
        console.error('getWalletFromMnemonic Error', {error, privateKey});
        throw error;
    }
}


/**
 * 获取一个注记词的bc1p地址
 * @param mnemonic
 * @param walletType
 * @returns {LocalWallet}
 */
function getMainBtcWallet(mnemonic, walletType = AddressType.P2TR) {
    return LocalWallet.fromMnemonic(walletType, NetworkType.MAINNET, mnemonic, '', "m/86'/0'/0'/0")
}

/**
 * 包装utxo
 * @param wallet
 * @param utxos
 * @param limit 最小的utxo限制, sats(单位)
 * @returns {*}
 */
function packUtxo(wallet, utxos, limit = 1000) {
    return utxos
        .map((v) => {
            const satoshis = v?.satoshis ? v.satoshis : v?.value;
            if (satoshis >= limit) {
                return {
                    txId: v.txid,
                    txid: v.txid,
                    outputIndex: v.vout,
                    vout: v.vout,
                    value: satoshis,
                    satoshis: satoshis,
                    scriptPk: wallet.scriptPk,
                    addressType: wallet.addressType,
                    pubkey: wallet.pubkey,
                    address: wallet.address,
                    atomicals: [],
                    inscriptions: [],
                    ords: [],
                }
            }
            return null;
        })
        .filter(v => v !== null)
        .sort((a, b) => b.satoshis - a.satoshis);
}

async function getUtxos(address, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(`https://mempool.space/api/address/${address}/utxo`, {
                httpsAgent: agent,
                timeout: 30000,
            });
            return response.data;
        } catch (error) {
            console.error(`第 ${attempt} 次尝试失败:`, error.message, error.response?.data);
            if (attempt === retries) {
                console.error('所有重试次数已用完');
                throw error;
            }
            const waitTime = attempt * 10;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    return [];
}

async function broadcastTransaction(txHex, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.post(
                'https://mempool.space/api/tx',
                txHex,
                {
                    headers: {
                        'content-type': 'text/plain',
                    },
                    httpsAgent: agent,
                    timeout: 30000,
                }
            );
            return response.data;
        } catch (error) {
            console.error(`第 ${attempt} 次广播失败:`, error.message, error.response?.data);
            if (attempt === retries) {
                console.error('所有重试次数已用完');
                throw error;
            }
            const waitTime = attempt * 10;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    return null;
}

async function getTxStatus(txid, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(`https://mempool.space/api/tx/${txid}`, {
                httpsAgent: agent,
                timeout: 5000,
            });
            return response.data;
        } catch (error) {
            if (error.status) {
                return {
                    del: true,
                }
            }

            console.error(`第 ${attempt} 次尝试失败:`, error.message);
            if (attempt === retries) {
                console.error('所有重试次数已用完');
                throw error;
            }
            const waitTime = attempt * 10;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    return null;
}


function printTx(rawtx) {
    const tx = bitcoin.Transaction.fromHex(rawtx);
    let ins = [];
    tx.ins.forEach((v) => {
        const txid = v.hash.reverse().toString('hex');
        const vout = v.index;
        ins.push({txid, vout});
    });

    let outs = [];
    tx.outs.forEach((v) => {
        const address = scriptPkToAddress(v.script);
        const satoshis = v.value;
        outs.push({address, satoshis});
    });

    let str = '\nPrint TX \n';
    str += `txid: ${tx.getId()}\n`;
    str += `\nInputs:(${ins.length})\n`;
    ins.forEach((v, index) => {
        str += `#${index} -- --\n`;
        str += `   ${v.txid} [${v.vout}]\n`;
    });

    str += `\nOutputs:(${outs.length})\n`;
    outs.forEach((v, index) => {
        str += `#${index} ${v.address} ${v.satoshis}\n`;
    });
    str += '\n';

    console.log(str);
}

function printPsbt(psbtData) {
    let psbt;
    if (typeof psbtData == 'string') {
        psbt = bitcoin.Psbt.fromHex(psbtData);
    } else {
        psbt = psbtData;
    }
    let totalInput = 0;
    let totalOutput = 0;
    let str = '\nPSBT:\n';
    str += `Inputs:(${psbt.txInputs.length})\n`;
    psbt.txInputs.forEach((input, index) => {
        const inputData = psbt.data.inputs[index];
        str += `#${index} ${scriptPkToAddress(
            inputData.witnessUtxo.script.toString('hex')
        )} ${inputData.witnessUtxo.value}\n`;
        str += `   ${Buffer.from(input.hash).reverse().toString('hex')} [${input.index}]\n`;
        totalInput += inputData.witnessUtxo.value;
    });

    str += `Outputs:(${psbt.txOutputs.length} )\n`;
    psbt.txOutputs.forEach((output, index) => {
        if (output.address) {
            str += `#${index} ${output.address} ${output.value}\n`;
            totalOutput += output.value;
        } else {
            if (output.script[0] === 0x6a) {
                let opreutrnDataString = 'OP_RETURN ';
                let curScript = output.script.slice(1);
                while (curScript.length > 0) {
                    const len = parseInt(curScript.slice(0, 1).toString('hex'), 16);
                    opreutrnDataString += curScript.slice(1, len + 1).toString('hex') + ' ';
                    curScript = curScript.slice(len + 1);
                }
                str += `#${index} ${opreutrnDataString} ${output.value}\n`;
            } else {
                str += `#${index} ${output.script.toString('hex')} ${output.value}\n`;
            }

            totalOutput += output.value;
        }
    });

    str += `Left: ${totalInput - totalOutput}\n`;
    try {
        const fee = psbt.getFee();
        const virtualSize = psbt.extractTransaction(true).virtualSize();
        const feeRate = fee / virtualSize;
        str += `Fee: ${fee}\n`;
        str += `FeeRate: ${feeRate}\n`;
        str += `VirtualSize: ${virtualSize}\n`;
    } catch (e) {
        // todo
    }

    str += '\n';
    console.log(str);
}

// 辅助函数：将数组按指定大小分块
function chunkArray(array, chunkSize) {
    const results = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        results.push(array.slice(i, i + chunkSize));
    }
    return results;
}

async function oneToMoreBtc(mainWallet, toAmount, feeRate, utxos, addresses, logger) {
    if (!logger) {
        logger = console;
    }
    //如果toAmount 为0
    if (toAmount <= 0) {
        throw new Error('Please set the transfer amount');
    }
    if (!feeRate) {
        throw new Error('Please set the fee rate');
    }

    let totalAmount = 0;
    const receivers = addresses
        .filter(address => isValidAddress(address, NetworkType.MAINNET))
        .map(address => {
            totalAmount += toAmount;
            return {address: address, amount: toAmount};
        });
    if (receivers.length === 0) {
        throw new Error("No valid addresses in this chunk.");
    }

    const totalSatoshis = utxos.reduce((acc, cur) => acc + cur.satoshis, 0);
    if (totalSatoshis <= totalAmount) {
        throw new Error(`Insufficient balance in main wallet, current balance: ${satoshisToAmount(totalSatoshis)} Btc，need: ${satoshisToAmount(totalAmount)} Btc`);
    }

    const receiversChunks = chunkArray(receivers, 888)
    const failedWallets = []; // 用来保存发送失败的钱包
    logger.warn(`A total of ${receiversChunks.length} transactions need to be sent`);
    for (const receivers of receiversChunks) {
        // TODO
        // 这里 utxos 可以静态计算出来，不需要每次都重新获取
        const _utxos = await getUtxos(mainWallet.address);
        const utxos = packUtxo(mainWallet, _utxos);
        try {
            const psbtHex = await createSendMultiBTC({
                utxos,
                receivers,
                wallet: mainWallet,
                network: mainWallet.network,
                changeAddress: mainWallet.address,
                pubkey: mainWallet.pubkey,
                feeRate,
                receiverToPayFee: false,
                enableRBF: true,
                dump: true
            })
            const rawTx = psbtHex.extractTransaction(true).toHex()
            console.log(rawTx)
            const txRes = await broadcastTransaction(rawTx);
            if (txRes?.length === 64) {
                logger.info(`Transaction: ${txRes}`);
            } else {
                logger.error(`Failed transaction: ${receivers.length} wallets`);
                failedWallets.push(...receivers);
            }
        } catch (e) {
            console.error(e);
            logger.error(`failed transaction: ${receivers.length} wallets`);
            failedWallets.push(...receivers);
        }
    }

    if (failedWallets.length) {
        // console.log(`失败的钱包:`);
        logger.error(`The Failed Wallet:`);
        //打印出 失败钱包的地址 一行一个
        console.log(failedWallets.map(receiver => receiver.address).join('\n'));
        // 这里可以将失败的钱包地址保存到文件中
        const failedData = failedWallets.map(receiver => receiver.address).join('\n');
        fs.appendFileSync("failTransferAddresses.txt", failedData + '\n');
        logger.error('The failed wallet has been saved to failed.txt');
    }
    logger.info('All transactions have been completed');
}

async function getCreateUtxosRawTx(wallets, utxos, toAmount = 0.000021, feeRate = 2) {
    const packedUtxo = packUtxo(wallets.mainWallet, utxos);
    const psbtHex = await createSendBTC({
        utxos: packedUtxo,
        toAddress: wallets.rgbWallet.address,
        toAmount: amountToSaothis(toAmount),
        wallet: wallets.mainWallet,
        network: bitcoin.networks.bitcoin,
        changeAddress: wallets.changeWallet.address,
        pubkey: wallets.mainWallet.pubkey,
        feeRate,
        receiverToPayFee: false,
        enableRBF: true,
        dump: false
    })
    return psbtHex.extractTransaction().toHex();
}



async function getSendUtxosRawTx(mainWallet, toAddress, utxos, toAmount = 0.000021, feeRate = 2) {
    const packedUtxo = packUtxo(mainWallet, utxos);
    const psbtHex = await createSendBTC({
        utxos: packedUtxo,
        toAddress: toAddress,
        toAmount: amountToSaothis(toAmount),
        wallet: mainWallet,
        network: bitcoin.networks.bitcoin,
        changeAddress: mainWallet.address,
        pubkey: mainWallet.pubkey,
        feeRate,
        receiverToPayFee: false,
        enableRBF: true,
        dump: false
    })
    return psbtHex.extractTransaction().toHex();
}


async function getToAnotherRawTx(fromWallets, toWallets, utxos, toAmount, feeRate = 2) {
    const packedUtxo = packUtxo(fromWallets.rgbWallet, utxos);
    const psbtHex = await createSendBTC({
        utxos: packedUtxo,
        toAddress: toWallets.mainWallet.address,
        toAmount: amountToSaothis(toAmount),
        wallet: fromWallets.rgbWallet,
        network: bitcoin.networks.bitcoin,
        changeAddress: fromWallets.rgbWallet.address,
        pubkey: fromWallets.rgbWallet.pubkey,
        feeRate,
        receiverToPayFee: true,
        enableRBF: true,
        dump: false
    })
    return psbtHex.extractTransaction().toHex();
}


async function generateWallets(count = 1) {
    const wallets = [];

    for (let i = 0; i < count; i++) {
        // 生成随机助记词
        const mnemonic = bip39.generateMnemonic();

        // 生成钱包 (bc1p类型，路径 m/86'/0'/0'/0)
        const wallet = LocalWallet.fromMnemonic(
            AddressType.P2TR,           // bc1p 地址类型
            NetworkType.MAINNET,        // 主网
            mnemonic,                   // 助记词
            '',                         // 密码（可选）
            "m/86'/0'/0'/0"            // 派生路径
        );

        wallets.push({
            address: wallet.address,
            mnemonic: mnemonic,
            path: "m/86'/0'/0'/0"
        });
    }

    return wallets;
}

module.exports = {
    getWalletFromPrivateKey,
    printTx,
    printPsbt,
    getUtxos,
    getTxStatus,
    broadcastTransaction,
    getBitlightWallet,
    getCreateUtxosRawTx,
    packUtxo,
    oneToMoreBtc,
    getToAnotherRawTx,
    getMainBtcWallet,
    getSendUtxosRawTx,
    generateWallets
}