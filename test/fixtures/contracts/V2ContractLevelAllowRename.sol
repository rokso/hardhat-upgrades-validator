// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @custom:upgrades-validator-unsafe-allow variable-renamed
contract V2ContractLevelAllowRename {
    /// @custom:storage-location erc7201:upgrades.test.v1
    struct Storage {
        uint256 value;
        uint256 counter;
        uint160 rawOwner;
        bool active;
    }

    uint256 public version;
    uint256 public data;
    uint256 public rawConfig;
    uint256 public unsafeRenameTarget;
    uint256 public unsafeRenameTarget2;
    uint256 public unsafeTypeSource;
}
