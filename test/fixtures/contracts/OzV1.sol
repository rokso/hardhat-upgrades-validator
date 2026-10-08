// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Baseline for OZ-native annotation tests (OzV2 approves changes with tags, OzV2NoTags does not).
contract OzV1 {
    /// @custom:storage-location erc7201:upgrades.test.oz
    struct OzStorage {
        uint256 amount;
        uint256 extra;
    }

    uint256 public legacyData;
    uint160 public rawOwner;
    uint256 public tail;
}
