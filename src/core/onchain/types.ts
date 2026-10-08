export type { EthProvider, LayoutRecord } from "slotdiff";

/**
 * Which implementation a proxy ran when last observed, so offline readers
 * (the compile hook, runs without an RPC) know which record applies.
 *
 * Written only from what the chain reports, never from what a deploy meant
 * to do, so a queued or discarded upgrade never moves it. It goes stale when
 * the proxy is upgraded outside this tool, until the next run with an RPC;
 * offline results therefore name the block it was observed at.
 */
export interface ProxyIndexEntry {
  format: 1;
  proxy: string;
  chainId: number;
  implementation: string;
  /** Set for a beacon proxy; `implementation` is then the beacon's. */
  beacon?: string;
  /**
   * Deployment names that describe the code behind the proxy. Files that
   * describe the proxy contract itself are excluded by comparing their code
   * with the chain, never by their names.
   */
  deployments: string[];
  observedAtBlock: number;
}
