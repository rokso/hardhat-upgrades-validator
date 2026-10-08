// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library OzUnsafeLib {
    function forward(address target) internal returns (bool ok) {
        (ok, ) = target.delegatecall("");
    }
}

// Same changes as OzV2NoTags, each approved with an OZ tag.
contract OzV2 {
    /// @custom:storage-location erc7201:upgrades.test.oz
    struct OzStorage {
        uint256 amount;
        uint256 extra;
    }

    /// @custom:oz-renamed-from legacyData
    uint256 public data;

    /// @custom:oz-retyped-from uint160
    address public rawOwner;

    uint256 public tail;

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public immutable fee;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        fee = 1;
    }

    /// @custom:oz-upgrades-unsafe-allow delegatecall
    function direct(address target) external {
        (bool ok, ) = target.delegatecall("");
        require(ok);
    }

    /// @custom:oz-upgrades-unsafe-allow-reachable delegatecall
    function viaLibrary(address target) external {
        require(OzUnsafeLib.forward(target));
    }
}
