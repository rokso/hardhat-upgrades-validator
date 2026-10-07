// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract LedgerV2 {
    uint256 public count;
    uint256 public step;

    function bump() external {
        count += step == 0 ? 1 : step;
    }
}
