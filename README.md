# Aztec Deploy Test

Deploys a Schnorr account on Aztec testnet, claims Fee Juice from L1, and prints the balance. Transaction fees are covered throughout by the Sponsored FPC contract so you never need pre-existing Fee Juice to get started.

## Prerequisites

- Node.js 18+
- A Sepolia Ethereum wallet with a small amount of Sepolia ETH (for L1 gas)
- Your Sepolia private key (32 bytes, `0x` + 64 hex characters)

If you need Sepolia ETH, get some from a faucet such as [sepoliafaucet.com](https://sepoliafaucet.com).

## Setup

```bash
npm install
```

## Usage

```bash
L1_PRIVATE_KEY=0x<your-sepolia-private-key> node src/index.js <l2-secret>
```

- `<l2-secret>` — any hex string you own (e.g. your Ethereum address). It is SHA-256 hashed to derive your Aztec Schnorr account, so the same value always produces the same account.
- `L1_PRIVATE_KEY` — your 32-byte Sepolia private key. Used to pay L1 gas when minting and bridging Fee Juice.
- `L1_RPC_URL` — (optional) Sepolia RPC endpoint. Defaults to `https://sepolia.drpc.org`.

**Example:**

```bash
L1_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  node src/index.js 0xF4e81041E41EF84cAd81C293F50F5F0e9E3f412E
```

---

## How it works

### Background concepts

**Aztec** is a privacy-focused L2 that settles on Ethereum. It has two layers:
- **L1 (Sepolia)** — Ethereum testnet where assets originate and where the rollup posts proofs.
- **L2 (Aztec testnet)** — the privacy chain where accounts and contracts live.

**Fee Juice** is the native token used to pay for L2 transactions, similar to ETH on Ethereum.

**FPC (Fee Paying Contract)** — a contract that pays transaction fees on behalf of users. The `SponsoredFPC` deployed on testnet is pre-funded by Aztec Labs and will sponsor any transaction unconditionally, meaning you can transact on L2 without holding any Fee Juice yourself.

---

### Step 1 — Derive the L2 account address

The script takes your `<l2-secret>` input and SHA-256 hashes it to produce a valid Aztec field element. This becomes the secret key for a **Schnorr account contract** — Aztec's default account type. Because the address is derived deterministically from the secret, the same input always gives the same address without needing to store anything.

```
l2-secret (any hex) → SHA-256 → Fr field element → Schnorr account address
```

### Step 2 — Deploy the account contract (if not already deployed)

On Aztec, accounts are smart contracts. Before you can transact, your account contract must be deployed on L2.

The script first checks the L2 node directly (`node.getContract(address)`) to see if the contract is already on-chain. If not, it sends a deployment transaction.

The deployment fee is paid by the **Sponsored FPC** — it calls `sponsor_unconditionally()` on the FPC contract, which covers the fee from the FPC's own Fee Juice balance. This means the deployment costs you nothing.

### Step 3 — Mint and bridge Fee Juice from L1

Fee Juice tokens originate on L1. The process has two parts:

1. **Mint on L1** — The `FeeAssetHandler` contract on Sepolia has a public `mint()` function that anyone can call on testnet to receive free Fee Juice tokens. The script calls this using your L1 wallet.

2. **Bridge to L2** — The minted tokens are approved and deposited into the `FeeJuicePortal` contract on L1, which locks them on L1 and emits an L1→L2 message. This message tells the L2 rollup that a specific amount of Fee Juice is ready to be claimed by a specific L2 address.

Both steps are handled automatically by `L1FeeJuicePortalManager.bridgeTokensPublic()`. It returns a **claim object** containing the amount, a claim secret, and a message leaf index — the proof needed to unlock the tokens on L2.

### Step 4 — Wait for the L1→L2 message

After the L1 transaction is mined, the Aztec sequencer needs to pick up the message and include it in an L2 block. This typically takes 1–3 minutes. The script polls `node.getL1ToL2Message()` every 5 seconds (up to 5 minutes) until the message is available.

### Step 5 — Claim Fee Juice on L2

Once the message is included, the script calls `FeeJuiceContract.claim()` on L2, passing the claim secret and leaf index. This proves ownership of the bridged tokens and credits them to the account's public Fee Juice balance.

The fee for this claim transaction is again paid by the **Sponsored FPC** — so the whole flow (deploy + bridge + claim) costs zero Fee Juice from your wallet.

### Step 6 — Print the balance

Finally, the script reads the account's public Fee Juice balance directly from L2 storage and prints it in both `wei` and `FJ`.

---

## Architecture overview

```
Your L1 wallet (Sepolia ETH)
        │
        ▼
FeeAssetHandler.mint()          ← free testnet mint
        │
        ▼
FeeJuicePortal.depositToAztecPublic()   ← locks tokens, emits L1→L2 message
        │
        │  (sequencer picks up message, ~1-3 min)
        │
        ▼
L2: FeeJuiceContract.claim()    ← unlocks tokens to your account
        │   fee paid by SponsoredFPC
        ▼
Account balance > 0 FJ
```
