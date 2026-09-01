/**
 * Spike 04 — Track B: does the daemon accept a MuSig2 aggregate key as a
 * vault's owner key? Per docs/COLLATERAL-MODEL.md §3.1 + §4.
 *
 * Two in-process keypairs (borrower, protocol) stand in for the real
 * interactive exchange (that comes with the HTTP nonce/partial-sig round trip
 * in a later task) — both secrets are known to this one script, so the
 * MuSig2 session runs entirely locally.
 *
 * Acceptance: registerVault committed with P_agg; pre-signed exit_tx passes
 * testmempoolaccept after mining csvBlocks; cosignRefund returns 5 partials;
 * the refund actually mines.
 */
import "dotenv/config";
import { WalletAggregator, Keystore, getNetwork } from "@tachibtc/taurus-wallet-aggregator";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import {
  IndividualPubkey,
  sortKeys,
  keyAggregate,
  keyAggExport,
  nonceGen,
  nonceAggregate,
  Session,
} from "@scure/btc-signer/musig2.js";
import {
  createVault,
  verifyVaultP2tr,
  depositToVault,
  registerVault,
  buildUnilateralExitPsbt,
  signUnilateralExitPsbtAsUser,
  finalizeUnilateralExitPsbt,
  buildToLocalP2trOutput,
  buildRefundPsbt,
  signRefundPsbtAsUser,
  cosignRefund,
  finalizeRefundPsbt,
  RefundCosignError,
  encodeStateHint,
  deriveStateObfuscator,
  quorumAggregateKey,
  describeTapscript,
} from "@tachibtc/taurus-vault-core";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  checkQuorum,
  registerDeposit,
} from "@satusd/tachi-kit";

const CSV_BLOCKS = 144; // demo term — see COLLATERAL-MODEL.md §3
const DEPOSIT = 300_000n;
const LEDGER_FEE = 10n; // regtest mempool minimum
const EXIT_FEE = 1_000n;
const REFUND_FEE = 1_000n;
const REFUND_USER_VALUE = 250_000n;
const REFUND_PROTOCOL_VALUE = 49_000n; // DEPOSIT - REFUND_USER_VALUE - REFUND_FEE

/**
 * In-process MuSig2 joint signer — stands in for the two-party interactive
 * protocol (docs/COLLATERAL-MODEL.md §4). Real usage splits this across an
 * HTTP round trip so neither side ever holds the other's secret; here both
 * secrets are local to make the spike self-contained.
 */
function createInProcessAggSigner(secretA: Uint8Array, secretB: Uint8Array) {
  const pubA = IndividualPubkey(secretA) as Uint8Array;
  const pubB = IndividualPubkey(secretB) as Uint8Array;
  const publicKeys = sortKeys([pubA, pubB]) as Uint8Array[];
  const ctx = keyAggregate(publicKeys);
  const xOnly = Buffer.from(keyAggExport(ctx) as Uint8Array);
  const compressed = Buffer.from((ctx.aggPublicKey as { toBytes(c: boolean): Uint8Array }).toBytes(true));

  async function signSchnorr(sighash: Buffer): Promise<Buffer> {
    const msg = new Uint8Array(sighash);
    const nonceA = nonceGen(pubA, secretA, xOnly, msg);
    const nonceB = nonceGen(pubB, secretB, xOnly, msg);
    const aggNonce = nonceAggregate([nonceA.public, nonceB.public]) as Uint8Array;
    const session = new Session(aggNonce, publicKeys, msg);
    const partialA = session.sign(nonceA.secret, secretA);
    const partialB = session.sign(nonceB.secret, secretB);
    const finalSig = session.partialSigAgg([partialA, partialB]);
    return Buffer.from(finalSig as Uint8Array);
  }

  return {
    publicKey: compressed,
    xOnly,
    sign: (): never => {
      throw new Error("ECDSA not supported on the MuSig2 owner key — Taproot paths only");
    },
    signSchnorr,
  };
}

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[musig] quorum:", await checkQuorum(tachi));

  const borrowerSecret = randomPrivateKeyBytes();
  const protocolSecret = randomPrivateKeyBytes();
  const aggSigner = createInProcessAggSigner(borrowerSecret, protocolSecret);
  console.log("[musig] P_agg x-only:", aggSigner.xOnly.toString("hex"));
  console.log("[musig] P_agg compressed:", aggSigner.publicKey.toString("hex"));

  const vault = await createVault({
    network: "regtest",
    userPubkey: aggSigner.publicKey,
    csvBlocks: CSV_BLOCKS,
    validators: { endpoint: `${config.tachiUrl}/tachi_validators` },
  });
  verifyVaultP2tr(vault.p2tr);
  if (vault.userKey.xOnly.toString("hex") !== aggSigner.xOnly.toString("hex")) {
    throw new Error("vault.userKey.xOnly does not match the MuSig2 aggregate key");
  }
  console.log("[musig] vault ACCEPTED P_agg as owner key:", vault.p2tr.address);
  console.log("[musig] exit leaf csvBlocks:", vault.p2tr.exitLeaf.csvBlocks);

  // Funding wallet is unrelated to the vault's owner key — any P2WPKH source works.
  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();

  const dep = await depositToVault({ vault, userWallet: funderWallet, rpc, amountSats: DEPOSIT, feeRateSatVb: 2 });
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  const raw = await rpc.call<{ vout: { n: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [
    dep.txid,
    true,
  ]);
  const spk = vault.p2tr.output.toString("hex");
  const vout = raw.vout.find((o) => o.scriptPubKey.hex === spk)!.n;
  console.log("[musig] funded", dep.txid, "vout", vout);

  const onboard = await registerDeposit(config, { userSigner: aggSigner, amountSats: DEPOSIT, feeSats: LEDGER_FEE });
  console.log("[musig] ledger VTXO onboarded (agg-signed):", onboard.vtxoId.toString("hex"));

  const reg = await registerVault({
    vault,
    outpoint: { fundingTxid: Buffer.from(dep.txid, "hex").reverse(), fundingVout: vout },
    userSigner: aggSigner,
    inputs: [{ vtxoId: onboard.vtxoId, txid: dep.txid, vout, valueSats: DEPOSIT }],
    outputs: [{ owner: Buffer.from(vault.userKey.xOnly), amount: DEPOSIT - LEDGER_FEE }],
    feeSats: LEDGER_FEE,
    broadcast: { url: `${config.tachiUrl}/tachi_txBroadcastSync` },
    account: { baseUrl: config.tachiUrl },
    confirm: { baseUrl: config.tachiUrl, overallTimeoutMs: 90_000 },
  });
  console.log(
    "[musig] VAULT REGISTERED (agg-signed) id=",
    reg.vaultIdHex,
    "committed=",
    reg.commit?.committed,
    "code=",
    reg.commit?.code,
  );

  // Pre-sign the exit tx BEFORE any loan asset would be released — this hex
  // is what the borrower holds. It needs the protocol's MuSig2 partial once,
  // here; never again after this.
  const funding = { txid: dep.txid, vout, valueSats: DEPOSIT, scriptPubKey: spk };
  const exitBuilt = buildUnilateralExitPsbt({
    vault,
    funding,
    outputs: [{ address: funderWallet.receiveAddress, valueSats: DEPOSIT - EXIT_FEE }],
    feeSats: EXIT_FEE,
  });
  const exitVerify = { maxFeeSats: 5_000n, expectedUserKey: vault.p2tr.exitLeaf.userKey, minCsvBlocks: CSV_BLOCKS };
  await signUnilateralExitPsbtAsUser(exitBuilt.psbt, aggSigner, vault, exitVerify);
  const exitTxHex = finalizeUnilateralExitPsbt(exitBuilt.psbt, vault, exitVerify);
  console.log("[musig] exit_tx pre-signed and held (not broadcast), length", exitTxHex.length, "hex chars");

  // Exit tx isn't valid yet — CSV hasn't matured. Confirm that.
  const tooEarly = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [exitTxHex],
  ]);
  console.log("[musig] exit_tx accepted before CSV matures?", tooEarly[0].allowed, tooEarly[0]["reject-reason"] ?? "");
  if (tooEarly[0].allowed) throw new Error("exit_tx should NOT be valid before the CSV delay matures");

  // Mine past the CSV delay and confirm exit_tx becomes valid — this is the
  // "kill the engine, borrower still gets their BTC" guarantee, and it must
  // hold even though the owner key is a joint MuSig2 key: the tx was fully
  // signed once, at open, and needs nobody's further cooperation to broadcast.
  // testmempoolaccept never consumes the UTXO, so the funding output is still
  // free to spend via the refund path below.
  await rpc.call("generatetoaddress", [CSV_BLOCKS, funderWallet.receiveAddress]);
  const matured = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [exitTxHex],
  ]);
  console.log("[musig] exit_tx accepted after CSV matures?", matured[0].allowed, matured[0]["reject-reason"] ?? "");
  if (!matured[0].allowed) throw new Error("exit_tx should be valid once the CSV delay has matured");

  // Commit a liquidation refund state — agg-signed, quorum-cosigned.
  const toLocal = buildToLocalP2trOutput({
    network: "regtest",
    nodePubkeys: vault.p2tr.cooperativeLeaf.nodeKeysCompressed,
    threshold: vault.p2tr.cooperativeLeaf.threshold,
    userDelayedPubkey: vault.userKey.xOnly,
    toSelfDelay: vault.p2tr.exitLeaf.csvBlocks,
  });
  const obf = deriveStateObfuscator(aggSigner.publicKey, quorumAggregateKey(vault.p2tr.cooperativeLeaf.nodeKeysCompressed));
  const hint = encodeStateHint(1n, obf);
  const refundBuilt = buildRefundPsbt({
    vault,
    funding,
    toLocal,
    userValueSats: REFUND_USER_VALUE,
    extraOutputs: [{ address: funderWallet.changeAddress, valueSats: REFUND_PROTOCOL_VALUE }],
    feeSats: REFUND_FEE,
    sequence: hint.sequence,
    locktime: hint.locktime,
  });
  const refundVerify = {
    maxFeeSats: 5_000n,
    toLocal,
    expectedUserValueSats: REFUND_USER_VALUE,
    expectedDelayedPubkey: vault.userKey.xOnly,
  };
  await signRefundPsbtAsUser(refundBuilt.psbt, aggSigner, vault, refundVerify);
  let refundHex: string;
  try {
    const res = await cosignRefund(refundBuilt.psbt, vault, {
      url: `${config.tachiUrl}/tachi_signTransaction`,
      timeoutMs: 90_000,
    });
    console.log("[musig] REFUND COSIGNED (agg-signed):", res.attached, "partials");
    refundHex = finalizeRefundPsbt(refundBuilt.psbt, vault, refundVerify);
  } catch (e) {
    if (e instanceof RefundCosignError) throw new Error(`cosign failed: status=${e.status} msg=${e.message}`);
    throw e;
  }

  const acceptRefund = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [refundHex],
  ]);
  console.log("[musig] refund testmempoolaccept:", acceptRefund[0].allowed, acceptRefund[0]["reject-reason"] ?? "");
  if (!acceptRefund[0].allowed) throw new Error("cosigned refund was not accepted by bitcoind");
  const refundTxid = await rpc.call<string>("sendrawtransaction", [refundHex]);
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  console.log("[musig] REFUND BROADCAST + MINED:", refundTxid);

  console.log(
    "[musig] PASS — daemon accepts a MuSig2 aggregate key as vault owner; exit_tx and refund_n both agg-signed and functional",
  );
}

main().catch((err) => {
  console.error("[musig] failed:", err);
  process.exit(1);
});
