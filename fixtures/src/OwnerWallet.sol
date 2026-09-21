// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract OwnerWallet {
    address public immutable controller;

    constructor(address owner) { controller = owner; }

    function forward(address target, bytes calldata data) external {
        require(msg.sender == controller, "controller only");
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
}
