const fs = require('fs');
const { bitcoin } = require('@unisat/wallet-sdk/lib/bitcoin-core');
const bip341 = require('bitcoinjs-lib/src/payments/bip341');
const { createSendBTC } = require('@unisat/ord-utils');
const { getUtxos, packUtxo, broadcastTransaction } = require('../../btcUtils');

function toXOnly(hexPubkey) {
    const buf = Buffer.from(hexPubkey, 'hex');
    return buf.length === 32 ? buf : buf.slice(1, 33);
}

function pushData(buffer) {
    const len = buffer.length;
    if (len < 0x4c) {
        return Buffer.concat([Buffer.from([len]), buffer]);
    } else if (len <= 0xff) {
        return Buffer.concat([Buffer.from([0x4c, len]), buffer]);
    } else if (len <= 0xffff) {
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16LE(len);
        return Buffer.concat([Buffer.from([0x4d]), lenBuf, buffer]);
    } else {
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(len);
        return Buffer.concat([Buffer.from([0x4e]), lenBuf, buffer]);
    }
}

function buildInscriptionScript(internalPubkey, contentType, bodyBuffer) {
    const xOnly = toXOnly(internalPubkey);
    const chunks = [
        pushData(xOnly),
        Buffer.from([bitcoin.opcodes.OP_CHECKSIG]),
        Buffer.from([bitcoin.opcodes.OP_FALSE]),
        Buffer.from([bitcoin.opcodes.OP_IF]),
        pushData(Buffer.from('ord')),
        pushData(Buffer.from([1])),
        pushData(Buffer.from(contentType)),
        Buffer.from([bitcoin.opcodes.OP_0]),
        pushData(bodyBuffer),
        Buffer.from([bitcoin.opcodes.OP_ENDIF]),
    ];
    const script = Buffer.concat(chunks);

    const payment = bitcoin.payments.p2tr({
        internalPubkey: xOnly,
        scriptTree: { output: script },
        redeem: { output: script },
        network: bitcoin.networks.bitcoin,
    });

    return { script, payment };
}

function estimateRevealVSize(payment, script, receiveAddress, revealOutputValue, changeAmount = 0, changeAddress = null) {
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    const fakePrev = Buffer.alloc(32, 0);
    tx.addInput(fakePrev, 0, 0xfffffffd);
    const receiveScript = bitcoin.address.toOutputScript(receiveAddress, bitcoin.networks.bitcoin);
    tx.addOutput(receiveScript, revealOutputValue);
    if (changeAmount > 0) {
        const changeScript = bitcoin.address.toOutputScript(changeAddress || payment.address, bitcoin.networks.bitcoin);
        tx.addOutput(changeScript, changeAmount);
    }
    tx.setWitness(0, [
        Buffer.alloc(64, 0),
        script,
        payment.witness[1],
    ]);
    return tx.virtualSize();
}

async function buildRevealTransaction({ wallet, commitTxId, commitVout, commitValue, script, payment, receiveAddress, revealOutputValue, changeAddress = null, changeAmount = 0 }) {
    const network = bitcoin.networks.bitcoin;
    const psbt = new bitcoin.Psbt({ network });
    psbt.addInput({
        hash: commitTxId,
        index: commitVout,
        witnessUtxo: {
            value: commitValue,
            script: payment.output,
        },
        tapLeafScript: [{
            leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
            script,
            controlBlock: payment.witness[1],
        }],
        tapInternalKey: toXOnly(wallet.pubkey),
    });
    psbt.addOutput({
        address: receiveAddress,
        value: revealOutputValue,
    });
    if (changeAmount > 0) {
        psbt.addOutput({
            address: changeAddress || wallet.address,
            value: changeAmount,
        });
    }

    const leafHash = bip341.tapleafHash({ output: script, version: bip341.LEAF_VERSION_TAPSCRIPT });
    const signed = await wallet.signPsbt(psbt, {
        autoFinalized: false,
        toSignInputs: [{
            index: 0,
            publicKey: wallet.pubkey,
            tapLeafHashToSign: leafHash,
            disableTweakSigner: true,
        }],
    });
    signed.finalizeAllInputs();
    const tx = signed.extractTransaction();
    const outputsSum = tx.outs.reduce((sum, out) => sum + out.value, 0);
    const actualFee = commitValue - outputsSum;
    return { hex: tx.toHex(), fee: actualFee, vsize: tx.virtualSize() };
}

async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function selectUtxos(wallet) {
    const utxos = await getUtxos(wallet.address);
    const packed = packUtxo(wallet, utxos);
    if (!packed.length) {
        throw new Error(`地址 ${wallet.address} 没有可用UTXO`);
    }
    return packed;
}

async function createCommitTx(wallet, commitAddress, commitAmount, feeRate, presetUtxos = null) {
    const utxos = presetUtxos || await selectUtxos(wallet);
    const psbt = await createSendBTC({
        utxos,
        toAddress: commitAddress,
        toAmount: commitAmount,
        wallet,
        network: bitcoin.networks.bitcoin,
        changeAddress: wallet.address,
        pubkey: wallet.pubkey,
        feeRate,
        receiverToPayFee: false,
        enableRBF: true,
        dump: false,
    });
    return psbt.extractTransaction().toHex();
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

module.exports = {
    toXOnly,
    buildInscriptionScript,
    estimateRevealVSize,
    buildRevealTransaction,
    wait,
    selectUtxos,
    createCommitTx,
    ensureDir,
    broadcastTransaction,
};
