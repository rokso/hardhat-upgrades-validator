import {
  getImplementationAddressFromProxy,
  type EthereumProvider,
} from "@openzeppelin/upgrades-core";
import { createHash } from "node:crypto";
import type { EthProvider } from "../proxy-detection.js";
import { BaselineUnavailableError } from "./errors.js";

/**
 * Reads the implementation a proxy runs right now: the ERC-1967
 * implementation slot, or the beacon's implementation for a beacon proxy.
 */
export async function readImplementation(provider: EthProvider, proxy: string): Promise<string> {
  const impl = await getImplementationAddressFromProxy(
    provider as unknown as EthereumProvider,
    proxy,
  );
  if (impl === undefined) {
    throw new BaselineUnavailableError(
      `${proxy} has no ERC-1967 implementation or beacon slot set on this chain.`,
    );
  }
  return impl.toLowerCase();
}

export async function readCode(provider: EthProvider, address: string): Promise<string> {
  const code = (await provider.send("eth_getCode", [address, "latest"])) as string;
  if (code === "0x" || code === "") {
    throw new BaselineUnavailableError(`No code at ${address} on this chain.`);
  }
  return code.toLowerCase();
}

export async function readChainId(provider: EthProvider): Promise<number> {
  return Number(BigInt((await provider.send("eth_chainId", [])) as string));
}

export function codeSha256(code: string): string {
  return createHash("sha256")
    .update(Buffer.from(code.replace(/^0x/, ""), "hex"))
    .digest("hex");
}
