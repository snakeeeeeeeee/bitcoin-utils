#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const bip39 = require('bip39');
const { wallet } = require('@unisat/wallet-sdk');
const { AddressType } = require('@unisat/wallet-sdk/lib/types');
const { NetworkType } = require('@unisat/wallet-sdk/lib/network');

const { LocalWallet } = wallet;

function parseArgs() {
    const args = process.argv.slice(2);
    const countFlagIndex = args.indexOf('--count');
    if (countFlagIndex !== -1) {
        const value = Number(args[countFlagIndex + 1]);
        if (Number.isFinite(value) && value > 0) {
            return Math.floor(value);
        }
    }

    const shortIndex = args.findIndex((arg) => arg.startsWith('--count='));
    if (shortIndex !== -1) {
        const value = Number(args[shortIndex].split('=')[1]);
        if (Number.isFinite(value) && value > 0) {
            return Math.floor(value);
        }
    }

    const positional = args.find((arg) => /^\d+$/.test(arg));
    if (positional) {
        return Math.max(1, Number(positional));
    }

    return 1;
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function createWallet() {
    const mnemonic = bip39.generateMnemonic();
    const wallet = LocalWallet.fromMnemonic(
        AddressType.P2TR,
        NetworkType.MAINNET,
        mnemonic,
        '',
        "m/86'/0'/0'/0",
    );
    return {
        mnemonic,
        address: wallet.address,
    };
}

async function main() {
    const count = parseArgs();
    const outputPath = path.resolve(__dirname, 'configs/btc-wallet.txt');
    ensureDir(path.dirname(outputPath));

    const wallets = Array.from({ length: count }, createWallet);
    const lines = wallets.map((item) => `${item.address}---${item.mnemonic}`).join('\n');
    fs.appendFileSync(outputPath, `${lines}\n`, 'utf8');

    console.log(`已生成 ${count} 个钱包，追加到 ${outputPath}`);
}

main().catch((error) => {
    console.error(`生成钱包失败: ${error.message}`);
    process.exit(1);
});

