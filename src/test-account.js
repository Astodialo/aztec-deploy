import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

const PRIV_KEY = process.argv[2] || process.exit(1);

async function main() {
  const keyBytes = Buffer.from(PRIV_KEY.replace("0x", ""), "hex");
  const keyHash = await crypto.subtle.digest("SHA-256", keyBytes);
  const secret = Fr.fromBufferReduce(Buffer.from(keyHash));

  console.log("Creating wallet with prover...");
  const wallet = await EmbeddedWallet.create("https://rpc.testnet.aztec-labs.com", { 
    ephemeral: true, 
    pxeConfig: { proverEnabled: true }, 
    databaseOpts: { path: "./db-test" } 
  });
  
  const accountManager = await wallet.createSchnorrAccount(secret, Fr.ZERO);
  const accountAddr = await accountManager.address;
  console.log("Account address:", accountAddr.toString());
  
  const node = createAztecNodeClient("https://rpc.testnet.aztec-labs.com");
  
  let isDeployed = false;
  try {
    const contract = await node.getContract(accountAddr);
    isDeployed = contract !== undefined;
  } catch (e) {
    console.log("Error checking contract:", e.message);
  }
  
  if (!isDeployed) {
    console.log("\nAccount NOT deployed on-chain.");
    console.log("Please go to https://aztec-faucet.nethermind.io");
    console.log("1. Go to Faucet tab");
    console.log("2. Enter address:", accountAddr.toString());
    console.log("3. Request Fee Juice");
    console.log("The faucet will auto-deploy your account.\n");
    await wallet.stop();
    return;
  }
  
  console.log("\nAccount IS deployed!");
  
  await wallet.stop();
  console.log("\nDone!");
}

main().catch(console.error);