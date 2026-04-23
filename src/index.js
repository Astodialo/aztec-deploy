import { Fr } from "@aztec/aztec.js/fields";
import { NO_FROM } from "@aztec/aztec.js/account";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { L1FeeJuicePortalManager } from "@aztec/aztec.js/ethereum";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";
import { createLogger } from "@aztec/aztec.js/log";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { createEthereumChain } from "@aztec/ethereum/chain";

const NODE_URL = "https://rpc.testnet.aztec-labs.com";
const L1_RPC_URL = process.env.L1_RPC_URL ?? "https://sepolia.drpc.org";

async function main() {
  const l2Secret = process.argv[2];
  const l1PrivateKey = process.env.L1_PRIVATE_KEY;

  if (!l2Secret || !l1PrivateKey) {
    console.log("Usage: L1_PRIVATE_KEY=<key> node src/index.js <l2-secret>");
    console.log("");
    console.log("  <l2-secret>     Any hex string to derive your L2 account (e.g. an Ethereum address)");
    console.log("  L1_PRIVATE_KEY  32-byte Sepolia private key (0x + 64 hex chars) — needed to mint and bridge fee juice");
    console.log("  L1_RPC_URL      (optional) Sepolia RPC URL. Default: https://sepolia.drpc.org");
    console.log("");
    console.log("Example:");
    console.log("  L1_PRIVATE_KEY=0xac09...ff80 node src/index.js 0xF4e81041E41EF84cAd81C293F50F5F0e9E3f412E");
    process.exit(1);
  }

  const rawKey = l1PrivateKey.replace('0x', '');
  if (rawKey.length !== 64) {
    console.error("Error: L1_PRIVATE_KEY must be 32 bytes (0x + 64 hex chars).");
    console.error(`       Got ${rawKey.length / 2} bytes — did you pass an address instead of a private key?`);
    process.exit(1);
  }
  const normalizedKey = `0x${rawKey}`;

  // Derive L2 Schnorr secret by hashing whatever bytes were provided
  const keyBytes = Buffer.from(l2Secret.replace('0x', ''), 'hex');
  const keyHash = await crypto.subtle.digest('SHA-256', keyBytes);
  const secret = Fr.fromBufferReduce(Buffer.from(keyHash));

  // Connect to L2 and derive L1 chain config from the node
  console.log("Connecting to L2 node...");
  const node = createAztecNodeClient(NODE_URL);
  const { l1ChainId } = await node.getNodeInfo();
  console.log("L1 chain ID:", l1ChainId);

  const { chainInfo } = createEthereumChain([L1_RPC_URL], l1ChainId);
  const l1Client = createExtendedL1Client([L1_RPC_URL], normalizedKey, chainInfo);
  console.log("L1 wallet:", l1Client.account.address);

  // Create L2 wallet and Schnorr account
  console.log("\nCreating L2 wallet...");
  const wallet = await EmbeddedWallet.create(NODE_URL, {
    ephemeral: true,
    pxeConfig: { proverEnabled: true },
  });

  const accountManager = await wallet.createSchnorrAccount(secret, Fr.ZERO);
  const accountAddr = accountManager.address;
  console.log("Account address:", accountAddr.toString());

  // Prepare Sponsored FPC
  console.log("\nRegistering Sponsored FPC...");
  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0) }
  );
  await wallet.registerContract(sponsoredFPCInstance, SponsoredFPCContract.artifact);
  console.log("Sponsored FPC at:", sponsoredFPCInstance.address.toString());
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCInstance.address);

  // Step 1: Deploy account if not already on-chain.
  // node.getContract() is the fast check, but can lag on a fresh node connection.
  // The nullifier catch is a fallback for when the node reports "not found" but the
  // contract is already deployed — attempting to re-deploy then hits a duplicate nullifier.
  console.log("\nChecking deployment status...");
  const existingInstance = await node.getContract(accountAddr);
  if (existingInstance) {
    console.log("Account already deployed.");
  } else {
    console.log("Deploying account with Sponsored FPC...");
    try {
      const deployMethod = await accountManager.getDeployMethod();
      const deployResult = await deployMethod.send({
        from: NO_FROM,
        fee: { paymentMethod: sponsoredPaymentMethod },
        wait: { returnReceipt: true }
      });
      const receipt = deployResult?.receipt ?? deployResult;
      console.log("  tx:      ", receipt?.txHash?.toString?.() ?? "n/a");
      console.log("  status:  ", receipt?.status ?? "unknown");
      console.log("  block:   ", receipt?.blockNumber ?? "n/a");
      if (receipt?.txHash) {
        console.log("  explorer:", "https://testnet.aztecscan.xyz/tx-effects/" + receipt.txHash.toString());
      }
    } catch (err) {
      const msg = err?.cause?.message ?? err?.message ?? '';
      if (msg.includes('Existing nullifier')) {
        console.log("Account already deployed (confirmed via nullifier check).");
      } else {
        throw err;
      }
    }
  }

  // Step 2: Mint fee juice on L1 via FeeAssetHandler and bridge it to L2
  console.log("\nBridging fee juice from L1...");
  const logger = createLogger("aztec-deploy");
  const portalManager = await L1FeeJuicePortalManager.new(node, l1Client, logger);
  const claim = await portalManager.bridgeTokensPublic(accountAddr, undefined, /* mint */ true);
  console.log("  Amount:  ", (Number(claim.claimAmount) / 1e18).toFixed(6), "FJ");
  console.log("  Message: ", claim.messageHash);

  // Step 3: Wait until the membership witness is available on the node.
  // getL1ToL2MessageMembershipWitness is what the PXE simulation actually calls —
  // if it returns undefined at 'latest', the claim simulation will fail even if the
  // checkpoint exists. We poll this directly to avoid the sync-lag false positive.
  console.log("\nWaiting for L1->L2 message witness...");
  const messageHashFr = Fr.fromHexString(claim.messageHash);
  let witnessReady = false;
  for (let i = 0; i < 60 && !witnessReady; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const witness = await node.getL1ToL2MessageMembershipWitness('latest', messageHashFr);
    if (witness !== undefined) {
      witnessReady = true;
      console.log("Witness available!");
    } else {
      console.log(`  Waiting... (${i + 1}/60)`);
    }
  }

  if (!witnessReady) {
    console.log("Witness not available after 5 minutes. Try again later.");
    await wallet.stop();
    return;
  }

  // Step 4: Claim fee juice on L2 — Sponsored FPC pays the transaction fee.
  // The PXE's local anchor block may still lag behind the node by a block or two,
  // so we retry on "No L1 to L2 message found" until the PXE catches up.
  console.log("\nClaiming fee juice (Sponsored FPC pays the fee)...");
  const feeJuice = FeeJuiceContract.at(wallet);
  let claimReceipt;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const claimResult = await feeJuice.methods
        .claim(accountAddr, claim.claimAmount, claim.claimSecret, new Fr(claim.messageLeafIndex))
        .send({ from: accountAddr, fee: { paymentMethod: sponsoredPaymentMethod }, wait: { returnReceipt: true } });
      claimReceipt = claimResult?.receipt ?? claimResult;
      break;
    } catch (err) {
      const msg = err?.message ?? '';
      if (msg.includes('No L1 to L2 message found') && attempt < 12) {
        console.log(`  PXE not yet synced, retrying in 5s... (${attempt}/12)`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw err;
      }
    }
  }

  console.log("  tx:      ", claimReceipt?.txHash?.toString?.() ?? "n/a");
  console.log("  status:  ", claimReceipt?.status ?? "unknown");
  console.log("  block:   ", claimReceipt?.blockNumber ?? "n/a");
  if (claimReceipt?.txHash) {
    console.log("  explorer:", "https://testnet.aztecscan.xyz/tx-effects/" + claimReceipt.txHash.toString());
  }

  // Step 5: Print balance
  console.log("\nFee Juice balance:");
  const balance = await getFeeJuiceBalance(accountAddr, node);
  console.log("  ", balance.toString(), "wei");
  console.log("  ", (Number(balance) / 1e18).toFixed(6), "FJ");

  await wallet.stop();
  console.log("\nDone!");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
