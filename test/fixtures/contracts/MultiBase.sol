// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract MultiBase {
    /**
     * @custom:storage-location erc7201:upgrades.test.base
     * @custom:upgrades-validator-renamed-from baseNum baseNumber
     */
    struct BaseStorage {
        uint256 baseNumber;
    }

    uint256 public baseValue;
}
