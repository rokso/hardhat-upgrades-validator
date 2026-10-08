// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Has a public upgradeToAndCall, so OZ infers the "uups" proxy kind.
contract UupsImpl {
    uint256 public value;

    function upgradeToAndCall(address, bytes memory) external payable {}
}
