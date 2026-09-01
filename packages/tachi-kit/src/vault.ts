import {
  createVault,
  verifyVaultP2tr,
  depositToVault,
  type CreateVaultArgs,
  type Vault,
  type DepositToVaultArgs,
  type DepositResult,
} from "@tachibtc/taurus-vault-core";
import type { NetworkConfig } from "./net.js";

export type { Vault, DepositResult };

/**
 * Create the protocol's two-leaf TAURUS vault: cooperative 5-of-7 validator
 * leaf, exit leaf spendable by the user alone after the CSV timelock.
 * Validator keys are fetched live from the KDHT endpoint.
 */
export async function createProtocolVault(
  config: NetworkConfig,
  args: Omit<CreateVaultArgs, "network" | "validators"> & { validatorTimeoutMs?: number },
): Promise<Vault> {
  const { validatorTimeoutMs, ...rest } = args;
  const vault = await createVault({
    network: config.network,
    validators: { endpoint: `${config.tachiUrl}/tachi_validators`, timeoutMs: validatorTimeoutMs },
    ...rest,
  });
  // createVault already re-verifies internally, but re-checking at the call
  // site catches drift if that internal guarantee ever changes.
  verifyVaultP2tr(vault.p2tr);
  return vault;
}

/**
 * Deposit BTC from a synced P2WPKH wallet into a vault's P2TR address.
 */
export async function deposit(args: DepositToVaultArgs): Promise<DepositResult> {
  return depositToVault(args);
}
