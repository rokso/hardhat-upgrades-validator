import type { EthProvider } from "slotdiff";

export { readChainId, readCode, readImplementation, readProxy, type ProxyState } from "slotdiff";

/** The block a proxy was observed at, for the proxy index's "as of block N". */
export async function readBlockNumber(provider: EthProvider): Promise<number> {
  return Number(BigInt((await provider.send("eth_blockNumber", [])) as string));
}
