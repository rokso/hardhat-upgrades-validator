// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract Ledger {
    uint256 public count;

    function bump() external {
        count += 1;
    }
}
