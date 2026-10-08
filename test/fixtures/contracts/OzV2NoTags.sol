// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library OzUnsafeLibNoTags {
    function forward(address target) internal returns (bool ok) {
        (ok, ) = target.delegatecall("");
    }
}

// Negative control for OzV2: the same changes without OZ tags must fail.
contract OzV2NoTags {
    /// @custom:storage-location erc7201:upgrades.test.oz
    struct OzStorage {
        uint256 amount;
        uint256 extra;
    }

    uint256 public data;

    address public rawOwner;

    uint256 public tail;

    uint256 public immutable fee;

    constructor() {
        fee = 1;
    }

    function direct(address target) external {
        (bool ok, ) = target.delegatecall("");
        require(ok);
    }

    function viaLibrary(address target) external {
        require(OzUnsafeLibNoTags.forward(target));
    }
}
