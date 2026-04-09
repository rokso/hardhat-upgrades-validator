// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract V2 {
    /**
     * @custom:storage-location erc7201:upgrades.test.v1
     * @custom:upgrades-validator-renamed-from value newValue
     * @custom:upgrades-validator-retyped-from uint256 counter
     * @custom:upgrades-validator-renamed-from rawOwner owner
     * @custom:upgrades-validator-retyped-from uint160 owner
     */
    struct Storage {
        uint256 newValue;
        bytes32 counter;
        address owner;
        bool active;
    }

    uint256 public version;

    /// @custom:upgrades-validator-renamed-from legacyData
    uint256 public data;

    /// @custom:upgrades-validator-retyped-from uint256
    bytes32 public rawConfig;

    /// @custom:upgrades-validator-unsafe-allow variable-renamed
    uint256 public unsafeRenameTarget;

    uint256 public unsafeRenameTarget2;

    /// @custom:upgrades-validator-unsafe-allow type-changed
    uint128 public unsafeTypeSource; // note: this is unsafe type change from uint256
}
