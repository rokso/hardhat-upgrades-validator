// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The validator should rejects the rename.
contract V2Broken {
    /// @custom:storage-location erc7201:upgrades.test.v1
    struct Storage {
        uint256 newValue; // renamed from value but no annotation
        uint256 counter;
        uint160 rawOwner;
        bool active;
    }

    uint256 public version;
    uint256 public legacyData;
    uint256 public rawConfig;
}
