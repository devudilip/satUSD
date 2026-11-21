/**
 * satUSD on Tachi EVM: deploys SatUSD + VaultManager and mirrors each engine
 * step on-chain. The engine still does the Bitcoin work (TAURUS vault, MuSig2,
 * pre-signed liquidation states); the contracts hold the debt, mint/burn the
 * ERC-20, and enforce the 150% / 130% rules.
 */
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import type { Abi, Hex } from "viem";
import type { NetworkConfig } from "@satusd/tachi-kit";
import { TachiEvmAccount, artifact, readContract, tachiScanUrl, type EvmTxResult, type GasFunder } from "./tachi-evm.js";

const CENT = 10n ** 16n; // satUSD has 18 decimals; the engine counts cents
const STATUS = ["none", "open", "liquidated", "closed", "exited"] as const;

const b32 = (hex: string): Hex => `0x${hex.replace(/^0x/, "").padStart(64, "0")}` as Hex;

export interface EvmVaultView {
  owner: Hex;
  status: (typeof STATUS)[number];
  collateralSats: bigint;
  debtCents: bigint;
  liquidationTxid: string;
  settleTxid: string;
}

export class SatUsdEvm {
  readonly client: TachiClient;
  readonly operator: TachiEvmAccount;
  /** The app's single demo user — the same person who owns the BTC vaults. */
  readonly user: TachiEvmAccount;
  token!: Hex;
  manager!: Hex;
  readonly explorer: string;
  private readonly managerAbi = artifact("VaultManager").abi as Abi;
  private readonly tokenAbi = artifact("SatUSD").abi as Abi;

  constructor(
    readonly config: NetworkConfig,
    seed: string,
    gas?: { funder: GasFunder; operatorSats: bigint; userSats: bigint; onFunded?: (account: TachiEvmAccount, txid: string, sats: bigint) => void },
  ) {
    this.client = new TachiClient({ baseUrl: config.tachiUrl });
    this.operator = new TachiEvmAccount(config, this.client, seed, "operator", gas && { funder: gas.funder, sats: gas.operatorSats, onFunded: gas.onFunded });
    this.user = new TachiEvmAccount(config, this.client, seed, "user", gas && { funder: gas.funder, sats: gas.userSats, onFunded: gas.onFunded });
    this.explorer = tachiScanUrl(config);
  }

  txUrl = (hash: string) => `${this.explorer}/tx/${hash}`;
  addressUrl = (addr: string) => `${this.explorer}/evm/contract/${addr}`;

  /** Fresh contracts every start, so on-chain state matches the in-memory engine. */
  async deploy(priceCents: bigint): Promise<{ token: EvmTxResult; manager: EvmTxResult }> {
    await this.operator.ensureGas();
    await this.user.ensureGas();
    const managerAddr = await this.operator.futureContractAddress(1n);
    const token = await this.operator.deploy("SatUSD", [managerAddr]);
    const manager = await this.operator.deploy("VaultManager", [token.receipt.contract_address, priceCents]);
    this.token = token.receipt.contract_address as Hex;
    this.manager = manager.receipt.contract_address as Hex;
    if (this.manager.toLowerCase() !== managerAddr.toLowerCase()) throw new Error("VaultManager landed at an unexpected address");
    return { token, manager };
  }

  private op = (fn: string, args: unknown[]) => this.operator.send(this.manager, this.managerAbi, fn, args);

  setPrice = (priceCents: bigint) => this.op("setPrice", [priceCents]);
  openVault = (id: string, collateralSats: bigint, btcVaultKey: string, depositTxid: string) =>
    this.op("openVault", [b32(id), this.user.address, collateralSats, b32(btcVaultKey), b32(depositTxid)]);
  generate = (id: string, cents: bigint, liquidationTxid: string) => this.op("generate", [b32(id), cents, b32(liquidationTxid)]);
  updateLiquidationTx = (id: string, liquidationTxid: string) => this.op("updateLiquidationTx", [b32(id), b32(liquidationTxid)]);
  liquidate = (id: string, btcTxid: string) => this.op("liquidate", [b32(id), b32(btcTxid)]);
  close = (id: string, btcTxid: string) => this.op("close", [b32(id), b32(btcTxid)]);
  recordExit = (id: string, btcTxid: string) => this.op("recordExit", [b32(id), b32(btcTxid)]);

  /** Signed by the vault owner's own EVM key — the contract checks msg.sender. */
  payBack = (id: string, cents: bigint) => this.user.send(this.manager, this.managerAbi, "payBack", [b32(id), cents]);
  transfer = (to: Hex, cents: bigint) => this.user.send(this.token, this.tokenAbi, "transfer", [to, cents * CENT]);

  async priceCents(): Promise<bigint> {
    return readContract<bigint>(this.client, this.manager, this.managerAbi, "priceCents");
  }
  async balanceCents(addr: Hex): Promise<bigint> {
    return (await readContract<bigint>(this.client, this.token, this.tokenAbi, "balanceOf", [addr])) / CENT;
  }
  async totalSupplyCents(): Promise<bigint> {
    return (await readContract<bigint>(this.client, this.token, this.tokenAbi, "totalSupply")) / CENT;
  }
  async vault(id: string): Promise<EvmVaultView> {
    const r = await readContract<readonly [Hex, number, bigint, bigint, Hex, Hex, Hex, Hex]>(this.client, this.manager, this.managerAbi, "vaults", [b32(id)]);
    return {
      owner: r[0],
      status: STATUS[r[1]] ?? "none",
      collateralSats: r[2],
      debtCents: r[3],
      liquidationTxid: r[6].slice(2),
      settleTxid: r[7].slice(2),
    };
  }
}

/** Engine CDP ids are not hex; hash them to the bytes32 the contract keys on. */
export { b32 };
