// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @custom:upgrades-validator-unsafe-allow type-changed
contract V2ContractLevelAllowTypeChange {
    /// @custom:storage-location erc7201:upgrades.test.v1
    struct Storage {
        uint256 value;
        uint256 counter;
        uint160 rawOwner;
        bool active;
    }

    uint256 public version;
    uint256 public legacyData;
    uint256 public rawConfig;
    uint256 public unsafeRenameSource;
    uint256 public unsafeRenameSource2;
    uint128 public unsafeTypeSource;
}
