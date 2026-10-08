// Records what the chain holds for every address in a deployments directory:
// runtime code and the ERC-1967 implementation and beacon slots.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const [dir, out] = process.argv.slice(2);
const IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
let id = 0;
const rpc = async (method, params) => {
  const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
};
const addrs = new Set();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."))) {
  const a = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).address; if (a) addrs.add(a.toLowerCase());
}
const state = { chainId: Number(await rpc("eth_chainId", [])), blockNumber: Number(await rpc("eth_blockNumber", [])), code: {}, implementations: {}, beacons: {} };
const toAddr = (w) => "0x" + w.slice(-40);
for (const a of [...addrs].sort()) {
  state.code[a] = await rpc("eth_getCode", [a, "latest"]);
  const i = await rpc("eth_getStorageAt", [a, IMPL, "latest"]);
  if (BigInt(i) !== 0n) state.implementations[a] = toAddr(i);
  const b = await rpc("eth_getStorageAt", [a, BEACON, "latest"]);
  if (BigInt(b) !== 0n) state.beacons[a] = toAddr(b);
}
// Implementations the proxies run, even if no file is at that address.
for (const impl of Object.values(state.implementations)) state.code[impl] ??= await rpc("eth_getCode", [impl, "latest"]);
writeFileSync(out, JSON.stringify(state, null, 2) + "\n");
console.log(out, Object.keys(state.code).length, "addresses", JSON.stringify(state.implementations));
