// Keeps only the deployment-file fields hardhat-upgrades-validator reads, with
// their real values: drops ABIs, docs, metadata and bundled sources.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
const [from, to] = process.argv.slice(2);
const KEEP = ["address", "contractName", "sourceName", "deployedBytecode", "immutableReferences", "deployedLinkReferences", "linkedData", "numDeployments"];
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from)) {
  if (!f.endsWith(".json")) { copyFileSync(`${from}/${f}`, `${to}/${f}`); continue; }
  const d = JSON.parse(readFileSync(`${from}/${f}`, "utf8"));
  const out = Object.fromEntries(KEEP.filter((k) => k in d).map((k) => [k, d[k]]));
  writeFileSync(`${to}/${f}`, JSON.stringify(out, null, 2) + "\n");
}
