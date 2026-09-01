/**
 * Phase 2b — THE FORK IN THE ROAD. Does the hosted daemon cosign a pre-signed
 * refund (`POST /tachi_signTransaction`)?
 *
 * A refund = spend the vault's funding output via the cooperative leaf into
 *   output[0]  to_local (user's, CSV-delayed, quorum-penalty-revocable)
 *   output[1+] arbitrary SegWit "extra" outputs  <-- a protocol/liquidator payout
 *
 * If the daemon returns >= 5 partials, Tachi supports PRE-COMMITTED,
 * self-custodial liquidation ("programmable collateral") today, and both
 * products should be built on it. If 503/504, refund signing is off on the
 * hosted daemon and soft liquidation is the honest MVP.
 */
import "dotenv/config";
import { WalletAggregator, Keystore, getNetwork } from "@tachibtc/taurus-wallet-aggregator";
import {
  buildToLocalP2trOutput, buildRefundPsbt, signRefundPsbtAsUser, cosignRefund,
  finalizeRefundPsbt, RefundCosignError, describeTapscript, registerVault,
  DAEMON_MIN_TO_LOCAL_SATS, DAEMON_MAX_IMPLIED_FEE_SATS,
} from "@tachibtc/taurus-vault-core";
import {
  resolveNetworkConfig, createTachiClient, createBitcoinRpcClient,
  assertTachiReachable, createProtocolVault, deposit, checkQuorum, registerDeposit,
} from "@satusd/tachi-kit";

const KEY_INDEX = Number(process.env.SPIKE_KEY_INDEX ?? 11); // fresh index: one deposit per vault
const DEPOSIT = 200_000n, USER_VALUE = 150_000n, PROTOCOL_VALUE = 49_000n, FEE = 1_000n;

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[refund] quorum:", await checkQuorum(tachi));
  console.log("[refund] daemon floors: minToLocal", DAEMON_MIN_TO_LOCAL_SATS, "maxImpliedFee", DAEMON_MAX_IMPLIED_FEE_SATS);

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await userWallet.sync();
  console.log("[refund] wallet balance:", userWallet.balance.confirmed);

  const vault = await createProtocolVault(config, { userWallet, userKeyIndex: KEY_INDEX });
  console.log("[refund] vault:", vault.p2tr.address, "threshold", vault.p2tr.cooperativeLeaf.threshold, "of", vault.p2tr.cooperativeLeaf.totalNodes);

  // Signer for the same receive index createVault used.
  const node = Keystore.fromMnemonic(mnemonic, "", getNetwork("regtest"), "p2wpkh", 0).signerFor(false, KEY_INDEX);
  const userSigner = {
    publicKey: Buffer.from(node.publicKey),
    sign: (h: Buffer) => Buffer.from(node.sign(h)),
    signSchnorr: (h: Buffer) => Buffer.from(node.signSchnorr!(h)),
  };
  const xonlyHex = Buffer.from(node.publicKey).subarray(1).toString("hex");
  if (xonlyHex !== Buffer.from(vault.userKey.xOnly).toString("hex")) throw new Error("signer key != vault user key");

  const dep = await deposit({ vault, userWallet, rpc, amountSats: DEPOSIT, feeRateSatVb: 2 });
  await rpc.call("generatetoaddress", [1, userWallet.receiveAddress]);
  const raw = await rpc.call<{ vout: { n: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [dep.txid, true]);
  const spk = vault.p2tr.output.toString("hex");
  const vout = raw.vout.find((o) => o.scriptPubKey.hex === spk)!.n;
  console.log("[refund] funded", dep.txid, "vout", vout);

  // Ledger side: (1) onboard a VTXO for this key so the account can pay the
  // open fee, (2) register the vault (TxVaultOpen) — the cosign gate requires it.
  const LEDGER_FEE = 10n; // regtest mempool rejects 0 ("fee below minimum")
  const onboard = await registerDeposit(config, { userSigner, amountSats: DEPOSIT, feeSats: LEDGER_FEE });
  console.log("[refund] ledger VTXO onboarded:", onboard.vtxoId.toString("hex"));
  const reg = await registerVault({
    vault,
    outpoint: { fundingTxid: Buffer.from(dep.txid, "hex").reverse(), fundingVout: vout },
    userSigner,
    inputs: [{ vtxoId: onboard.vtxoId, txid: dep.txid, vout, valueSats: DEPOSIT }],
    outputs: [{ owner: Buffer.from(vault.userKey.xOnly), amount: DEPOSIT - LEDGER_FEE }],
    feeSats: LEDGER_FEE,
    broadcast: { url: `${config.tachiUrl}/tachi_txBroadcastSync` },
    account: { baseUrl: config.tachiUrl },
    confirm: { baseUrl: config.tachiUrl, overallTimeoutMs: 90_000 },
  });
  console.log("[refund] VAULT REGISTERED id=", reg.vaultIdHex, "committed=", reg.commit?.committed, "code=", reg.commit?.code, reg.commit?.log || "");

  // to_local bound to the vault: same quorum/threshold, delay == exit CSV.
  const toLocal = buildToLocalP2trOutput({
    network: "regtest",
    nodePubkeys: vault.p2tr.cooperativeLeaf.nodeKeysCompressed,
    threshold: vault.p2tr.cooperativeLeaf.threshold,
    userDelayedPubkey: vault.userKey.xOnly,
    toSelfDelay: vault.p2tr.exitLeaf.csvBlocks,
  });
  console.log("[refund] to_local script:", describeTapscript(toLocal.script).slice(0, 160), "...");

  const protocolAddress = userWallet.changeAddress; // stand-in for the protocol's liquidation address
  const { listVaults, encodeStateHint, deriveStateObfuscator, quorumAggregateKey } = await import("@tachibtc/taurus-vault-core");
  const obf = deriveStateObfuscator(Buffer.from(vault.userKey.compressedHex!, "hex"), quorumAggregateKey(vault.p2tr.cooperativeLeaf.nodeKeysCompressed));

  async function commitState(stateNum: bigint, userValue: bigint, protocolValue: bigint) {
    const hint = encodeStateHint(stateNum, obf);
    const { psbt } = buildRefundPsbt({
      vault, funding: { txid: dep.txid, vout, valueSats: DEPOSIT, scriptPubKey: spk },
      toLocal, userValueSats: userValue, extraOutputs: [{ address: protocolAddress, valueSats: protocolValue }],
      feeSats: FEE, sequence: hint.sequence, locktime: hint.locktime,
    });
    const verify = { maxFeeSats: 5_000n, toLocal, expectedUserValueSats: userValue, expectedDelayedPubkey: vault.userKey.xOnly };
    await signRefundPsbtAsUser(psbt, userSigner, vault, verify);
    try {
      const res = await cosignRefund(psbt, vault, { url: `${config.tachiUrl}/tachi_signTransaction`, timeoutMs: 90_000 });
      console.log(`[refund] state ${stateNum} (user ${userValue} / protocol ${protocolValue}) COSIGNED: ${res.attached} partials`);
      return finalizeRefundPsbt(psbt, vault, verify);
    } catch (e) {
      if (e instanceof RefundCosignError) { console.log(`[refund] state ${stateNum} COSIGN FAILED status=${e.status} msg=${e.message}`); return null; }
      throw e;
    }
  }

  const hexA = await commitState(1n, USER_VALUE, PROTOCOL_VALUE);          // loan opened
  const hexB = await commitState(2n, 100_000n, 99_000n);                     // e.g. interest accrued / price moved
  const hexC = await commitState(2n, 120_000n, 79_000n);                     // same state number, different split
  const vaults = await listVaults(vault.userKey.compressedHex!, { baseUrl: config.tachiUrl });
  const mine = vaults.vaults.find((v) => v.address === vault.p2tr.address);
  console.log("[refund] listVaults record:", JSON.stringify(mine));

  const chosen = hexB ?? hexA;
  if (!chosen) process.exit(2);
  const accept = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[chosen]]);
  console.log("[refund] testmempoolaccept(state B):", accept[0].allowed, accept[0]["reject-reason"] ?? "");
  if (!accept[0].allowed) process.exit(3);
  const txid = await rpc.call<string>("sendrawtransaction", [chosen]);
  await rpc.call("generatetoaddress", [1, userWallet.receiveAddress]);
  console.log("[refund] BROADCAST + MINED state B:", txid);
  // Is state A (older, now conflicting) still relayable? It double-spends the funding outpoint, so it must not be.
  if (hexA) { const a = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[hexA]]); console.log("[refund] stale state A accepted?", a[0].allowed, a[0]["reject-reason"] ?? ""); }
  console.log("[refund] PASS");
}
main().catch((e) => { console.error("[refund] failed:", e); process.exit(1); });
