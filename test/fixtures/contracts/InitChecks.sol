// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Initializer fixtures for OZ's initializer checks (no OZ imports needed:
// OZ detects initializers by the `initializer` / `onlyInitializing` modifiers).
abstract contract InitBase {
    uint256 public baseValue;

    modifier initializer() {
        _;
    }

    modifier onlyInitializing() {
        _;
    }

    function __InitBase_init() internal onlyInitializing {
        baseValue = 1;
    }
}

// Has an initializer but never calls the parent's.
contract InitMissingCall is InitBase {
    function initialize() public initializer {}
}

// Calls the parent's initializer: the passing control.
contract InitCallsParent is InitBase {
    function initialize() public initializer {
        __InitBase_init();
    }
}
