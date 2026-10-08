// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The validator should reject both member renames (no struct tags).
contract V2Broken {
    /// @custom:storage-location erc7201:upgrades.test.v1
    struct Storage {
        uint256 newValue; // renamed from value but no annotation
        uint256 counter;
        uint160 rawOwner;
        bool active;
    }

    struct Position {
        uint256 x;
        uint256 height; // renamed from y but no annotation
    }

    uint256 public version;
    uint256 public legacyData;
    uint256 public rawConfig;
    Position public position;
}
