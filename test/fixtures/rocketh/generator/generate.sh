#!/usr/bin/env bash
# Regenerates test/fixtures/rocketh from real hardhat-deploy v2 runs.
#   ./generate.sh <output dir>
# Run 1 (owner the deployer controls): fresh deploy, then an executed upgrade to V2.
# Run 2 (Vault owned by an address without a key): fresh deploy, then a V2 deploy
# whose UUPS upgrade cannot be signed, leaving it pending as a multisig would.
set -euo pipefail
OUT=$(cd "$1" && pwd)
cd "$(dirname "$0")"
DEAD=0x000000000000000000000000000000000000dEaD

run() {
  rm -rf deployments
  npx hardhat node --port 8545 > node.log 2>&1 &
  local node=$!
  trap "kill $node 2>/dev/null || true" RETURN
  until curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 > /dev/null; do sleep 1; done
  "$@"
}

snapshot() {
  node trim.mjs deployments/localhost "$OUT/$1"
  node capture.mjs deployments/localhost "$OUT/$1.chain.json"
}

executed() {
  npx hardhat deploy --network localhost --skip-prompts > /dev/null
  snapshot fresh
  FIXTURE_V2=1 npx hardhat deploy --network localhost --skip-prompts > /dev/null
  snapshot upgraded
}

pending() {
  FIXTURE_VAULT_OWNER=$DEAD npx hardhat deploy --network localhost --skip-prompts > /dev/null
  FIXTURE_V2=1 npx hardhat deploy --network localhost --skip-prompts --tags Vault > /dev/null 2>&1 || true
  snapshot queued
}

rm -rf "$OUT/fresh" "$OUT/upgraded" "$OUT/queued"
run executed
run pending
