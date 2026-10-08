// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract Counter {
    uint256 public count;

    function bump() external {
        count += 1;
    }
}
