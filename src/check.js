import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

const PRIV_KEY = process.argv[2] || "142d79ccf63c9d43cc400b9f2bc4b4220a027d5f7e6fe62c11015cc5fc5977b8";

async function main() {
  const keyBytes = Buffer.from(PRIV_KEY.replace("0x", ""), "hex");
  const keyHash = await crypto.subtle.digest("SHA-256", keyBytes);
  const secret = Fr.fromBufferReduce(Buffer.from(keyHash));

  console.log("Creating wallet...");
  const wallet = await EmbeddedWallet.create("https://rpc.testnet.aztec-labs.com", { 
    ephemeral: true, 
    pxeConfig: { proverEnabled: true }, 
    databaseOpts: { path: "./db-check" } 
  });
  
  const accountManager = await wallet.createSchnorrAccount(secret, Fr.ZERO);
  const accountAddr = await accountManager.address;
  console.log("Account:", accountAddr.toString());
  
  const node = createAztecNodeClient("https://rpc.testnet.aztec-labs.com");
  try {
    const contract = await node.getContract(accountAddr);
    if (contract) {
      console.log("Contract info:", contract);
      console.log("SUCCESS: Account is deployed!");
    } else {
      console.log("NOT deployed - contract not found on chain");
    }
  } catch (e) {
    console.log("NOT deployed:", e.message);
  }
  
  await wallet.stop();
}

main().catch(console.error);