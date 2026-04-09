// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MultiBase.sol";

contract Multi is MultiBase {
    /// @custom:storage-location erc7201:upgrades.test.multi
    struct Storage {
        uint256 value;
        address owner;
    }

    uint256 public regularValue;
}
