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

    /**
     * @custom:upgrades-validator-renamed-from y height
     * @custom:upgrades-validator-retyped-from uint256 x
     */
    struct Position {
        bytes32 x;
        uint256 height;
    }

    uint256 public version;

    /// @custom:oz-renamed-from legacyData
    uint256 public data;

    /// @custom:oz-retyped-from uint256
    bytes32 public rawConfig;

    Position public position;
}
