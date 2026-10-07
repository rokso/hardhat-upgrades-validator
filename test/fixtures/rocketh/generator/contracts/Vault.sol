// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// UUPS logic with an immutable, so its deployment file carries immutableReferences.
contract Vault is Initializable, UUPSUpgradeable {
    /// @custom:storage-location erc7201:hhuv.storage.Vault
    struct VaultStorage {
        address owner;
        uint256 total;
    }

    // keccak256(abi.encode(uint256(keccak256("hhuv.storage.Vault")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_STORAGE =
        keccak256(abi.encode(uint256(keccak256("hhuv.storage.Vault")) - 1)) & ~bytes32(uint256(0xff));

    uint256 public immutable version;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        version = 1;
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        _vault().owner = owner_;
    }

    function owner() external view returns (address) {
        return _vault().owner;
    }

    function deposit(uint256 amount_) external {
        _vault().total += amount_;
    }

    function _vault() private pure returns (VaultStorage storage $) {
        bytes32 _location = VAULT_STORAGE;
        assembly {
            $.slot := _location
        }
    }

    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == _vault().owner, "not owner");
    }
}
