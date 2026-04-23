import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { GasSettings } from "@aztec/stdlib/gas";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

const SECRET = process.argv[2];
const CLAIM_SECRET_HEX = process.argv[3];
const LEAF_INDEX = process.argv[4];
const AMOUNT = process.argv[5] || "1000000000000000000";
const NODE_URL = "https://rpc.testnet.aztec-labs.com";

async function main() {
  if (!SECRET || !CLAIM_SECRET_HEX || !LEAF_INDEX) {
    console.log("Usage: node src/claim.js <secret-key> <claim-secret> <leaf-index> [amount]");
    console.log("");
    console.log("Arguments:");
    console.log("  secret-key      - Your EVM private key (hashed to get Aztec secret)");
    console.log("  claim-secret    - The secret from the faucet (from drip response)");
    console.log("  leaf-index     - The message leaf index from the faucet");
    console.log("  amount         - Optional: amount to claim (default: 1 FJ)");
    console.log("");
    console.log("Example:");
    console.log("  node src/claim.js 0x8eeb3c8af... 0x286f6f59b7cdbc4... 51204096");
    process.exit(1);
  }

  const amount = BigInt(AMOUNT);
  const claimSecret = Fr.fromHexString(CLAIM_SECRET_HEX);
  const leafIndex = BigInt(LEAF_INDEX);

  console.log("Creating wallet with prover enabled...");
  const wallet = await EmbeddedWallet.create(NODE_URL, { 
    ephemeral: true, 
    pxeConfig: { proverEnabled: true },
    databaseOpts: { path: `./db-${Date.now()}` }
  });

  // Hash EVM key to get valid field element
  const keyBytes = Buffer.from(SECRET.replace('0x', ''), 'hex');
  const keyHash = await crypto.subtle.digest('SHA-256', keyBytes);
  const secret = Fr.fromBufferReduce(Buffer.from(keyHash));

  console.log("Creating Schnorr account...");
  const accountManager = await wallet.createSchnorrAccount(secret, Fr.ZERO);
  const accountAddr = await accountManager.address;
  console.log("Account address:", accountAddr.toString());

  console.log("Checking if deployed...");
  const metadata = await wallet.getContractMetadata(accountAddr);
  
  if (!metadata.isContractInitialized) {
    console.log("\nAccount not deployed yet!");
    console.log("You need Fee Juice to deploy. Get some from the faucet first:");
    console.log("  1. Go to https://faucet.aztec.network");
    console.log("  2. Enter your address:", accountAddr.toString());
    console.log("  3. Get Fee Juice\n");
    await wallet.stop();
    return;
  }

  console.log("Setting up gas...");
  const node = createAztecNodeClient(NODE_URL);
  const minFees = await node.getCurrentMinFees();
  const gasSettings = GasSettings.from({
    gasLimits: { daGas: 100000, l2Gas: 2000000 },
    teardownGasLimits: { daGas: 10000, l2Gas: 200000 },
    maxFeesPerGas: { 
      feePerDaGas: minFees.feePerDaGas * 2n, 
      feePerL2Gas: minFees.feePerL2Gas * 2n 
    },
    maxPriorityFeesPerGas: { feePerDaGas: 0n, feePerL2Gas: 0n }
  });

  const claim = {
    claimAmount: amount,
    claimSecret: claimSecret,
    messageLeafIndex: leafIndex
  };

  console.log("Creating claim tx...");
  const { FeeJuiceContract } = await import("@aztec/aztec.js/protocol");

  console.log("Sending claim transaction...");
  const result = await FeeJuiceContract.at(wallet).methods
    .claim(accountAddr, amount, claimSecret, new Fr(leafIndex))
    .send({ from: accountAddr, fee: { gasSettings } });

  console.log("Tx sent:", result.transactionHash?.toString());
  console.log("Waiting for it to be mined...");

  await wallet.stop();
  
  console.log("\nDone!");
  console.log("Tx:", result.transactionHash?.toString());
  console.log("Explorer: https://testnet.aztecscan.xyz/tx-effects/" + result.transactionHash?.toString());
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});