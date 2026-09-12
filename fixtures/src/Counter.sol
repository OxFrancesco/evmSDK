// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Counter {
    uint256 public count;
    string public constant symbol = "TEST";
    uint8 public constant decimals = 18;
    event Changed(address indexed sender, uint256 value);
    error TooLarge(uint256 value);
    struct Pair { uint256 a; uint256 b; }

    function set(uint256 value) external {
        if (value > 1000) revert TooLarge(value);
        count = value;
        emit Changed(msg.sender, value);
    }

    function sum(Pair calldata pair, uint256[] calldata extra) external pure returns (uint256 value) {
        value = pair.a + pair.b;
        for (uint256 i; i < extra.length; i++) value += extra[i];
    }

    function balanceOf(address) external view returns (uint256) { return count; }
}
