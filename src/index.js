import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { GasSettings } from "@aztec/stdlib/gas";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

const NODE_URL = "https://rpc.testnet.aztec-labs.com";
const FAUCET_URL = "https://aztec-faucet.nethermind.io/api/drip";

function createGasSettings(node) {
  const minFees = { feePerDaGas: 0n, feePerL2Gas: 0n };
  return {
    get daGas() { return minFees.feePerDaGas; },
    get l2Gas() { return minFees.feePerL2Gas; },
    mul(n) {
      return {
        feePerDaGas: minFees.feePerDaGas * n,
        feePerL2Gas: minFees.feePerL2Gas * n
      };
    }
  };
}

async function main() {
  const secretArg = process.argv[2];
  if (!secretArg) {
    console.log("Usage: node src/index.js <evm-private-key>");
    console.log("Example: node src/index.js 0x...");
    process.exit(1);
  }

  console.log("Creating wallet with prover enabled...");
  const wallet = await EmbeddedWallet.create(NODE_URL, { 
    ephemeral: true, 
    pxeConfig: { proverEnabled: true },
    databaseOpts: { path: `./db-${Date.now()}` }
  });

  const keyBytes = Buffer.from(secretArg.replace('0x', ''), 'hex');
  const keyHash = await crypto.subtle.digest('SHA-256', keyBytes);
  const secret = Fr.fromBufferReduce(Buffer.from(keyHash));

  console.log("Creating Schnorr account...");
  const accountManager = await wallet.createSchnorrAccount(secret, Fr.ZERO);
  const accountAddr = await accountManager.address;
  console.log("Account address:", accountAddr.toString());

  console.log("Checking if already deployed onchain...");
  const metadata = await wallet.getContractMetadata(accountAddr);
  const isDeployed = metadata.isContractInitialized;
  
  if (isDeployed) {
    console.log("Account already deployed! Claiming Fee Juice...");
    await claimFeeJuice(wallet, accountAddr, null);
    await wallet.stop();
    return;
  }
  
  console.log("Not deployed, requesting Fee Juice...");

  let claimData = null;
  try {
    const claimResponse = await fetch(
      FAUCET_URL,
      { 
        method: "POST", 
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: accountAddr.toString(), asset: "fee-juice" })
      }
    );
    if (claimResponse.ok) {
      claimData = await claimResponse.json();
      console.log("Got claim data:", claimData);
    }
  } catch (e) {
    console.log("Faucet error:", e.message);
  }

  if (!claimData) {
    console.log("Failed to get Fee Juice from faucet.");
    console.log("Please request manually at https://aztec-faucet.nethermind.io");
    await wallet.stop();
    process.exit(1);
  }

  console.log("\nWaiting for L1->L2 message (1-2 minutes)...");
  
  const node = createAztecNodeClient(NODE_URL);
  const minFees = await node.getCurrentMinFees();
  const maxFeesPerGas = minFees.mul(2);
  const gasSettings = GasSettings.from({
    gasLimits: { daGas: 1000000n, l2Gas: 1000000n },
    teardownGasLimits: { daGas: 100000n, l2Gas: 100000n },
    maxFeesPerGas,
    maxPriorityFeesPerGas: maxFeesPerGas
  });

  const c = claimData.claimData;
  const claim = {
    claimAmount: BigInt(c.claimAmount),
    claimSecret: Fr.fromHexString(c.claimSecretHex),
    messageLeafIndex: BigInt(c.messageLeafIndex)
  };

  let attempts = 0;
  const maxAttempts = 60;
  let ready = false;
  
  while (attempts < maxAttempts && !ready) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;
    
    try {
      await node.getL1ToL2Message(c.messageHashHex);
      ready = true;
      console.log("L1->L2 message ready!");
    } catch (e) {
      console.log(`Waiting... (${attempts}/${maxAttempts})`);
    }
  }

  if (!ready) {
    console.log("Message not ready. Check L1 tx:", c.l1TxHash);
    await wallet.stop();
    return;
  }

  console.log("Deploying account + claiming Fee Juice...");
  const paymentMethod = new FeeJuicePaymentMethodWithClaim(accountAddr, claim);
  const deployMethod = await accountManager.getDeployMethod();

  const result = await deployMethod.send({
    from: AztecAddress.ZERO,
    fee: { gasSettings, paymentMethod },
    wait: { returnReceipt: true }
  });

  const receipt = result?.receipt ?? result;
  console.log("\nTransaction:");
  console.log("  tx:", receipt?.txHash?.toString?.() ?? "n/a");
  console.log("  status:", receipt?.status ?? "unknown");
  console.log("  block:", receipt?.blockNumber ?? "n/a");

  await wallet.stop();
}

async function claimFeeJuice(wallet, accountAddr, claimData) {
  if (!claimData) {
    console.log("No claim data - asking faucet...");
    try {
      const res = await fetch(
        FAUCET_URL,
        { 
          method: "POST", 
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: accountAddr.toString(), asset: "fee-juice" })
        }
      );
      if (!res.ok) {
        console.log("Faucet returned:", res.status);
        return;
      }
      claimData = await res.json();
      console.log("Got claim data:", claimData);
    } catch (e) {
      console.log("Faucet error:", e.message);
      return;
    }
  }

  const node = createAztecNodeClient(NODE_URL);
  const minFees = await node.getCurrentMinFees();
  const maxFeesPerGas = minFees.mul(2);
  const gasSettings = GasSettings.from({
    gasLimits: { daGas: 1000000n, l2Gas: 1000000n },
    teardownGasLimits: { daGas: 100000n, l2Gas: 100000n },
    maxFeesPerGas,
    maxPriorityFeesPerGas: maxFeesPerGas
  });

  const c = claimData.claimData;
  const claim = {
    claimAmount: BigInt(c.claimAmount),
    claimSecret: Fr.fromHexString(c.claimSecretHex),
    messageLeafIndex: BigInt(c.messageLeafIndex)
  };

  console.log("Waiting for L1->L2 message...");
  let attempts = 0;
  const maxAttempts = 60;
  let ready = false;
  
  while (attempts < maxAttempts && !ready) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;
    try {
      await node.getL1ToL2Message(c.messageHashHex);
      ready = true;
    } catch (e) {
      console.log(`Waiting... (${attempts}/${maxAttempts})`);
    }
  }

  if (!ready) {
    console.log("Message not ready");
    return;
  }

  console.log("Claiming Fee Juice...");
  const paymentMethod = new FeeJuicePaymentMethodWithClaim(accountAddr, claim);
  
  const { FeeJuiceContract } = await import("@aztec/aztec.js/protocol");
  const feeJuice = FeeJuiceContract.at(wallet);
  
  const result = await feeJuice.methods
    .check_balance(0n)
    .send({ from: accountAddr, fee: { gasSettings, paymentMethod } });
  
  const receipt = result?.receipt ?? result;
  console.log("  tx:", receipt?.txHash?.toString?.() ?? "n/a");
  console.log("  status:", receipt?.status ?? "unknown");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});