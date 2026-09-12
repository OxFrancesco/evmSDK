// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Asset {
    string public constant symbol = "ASSET";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { require(allowance[from][msg.sender] >= amount, "allowance"); allowance[from][msg.sender] -= amount; _transfer(from, to, amount); return true; }
    function _transfer(address from, address to, uint256 amount) internal { require(balanceOf[from] >= amount, "balance"); balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); }
}
contract Vault {
    Asset public immutable asset;
    mapping(address => uint256) public balanceOf;
    constructor(Asset token) { asset = token; }
    function previewDeposit(uint256 amount) external pure returns (uint256) { return amount; }
    function previewRedeem(uint256 amount) external pure returns (uint256) { return amount; }
    function convertToAssets(uint256 amount) external pure returns (uint256) { return amount; }
    function deposit(uint256 amount, address receiver) external returns (uint256) { asset.transferFrom(msg.sender, address(this), amount); balanceOf[receiver] += amount; return amount; }
    function redeem(uint256 amount, address receiver, address owner) external returns (uint256) { require(msg.sender == owner && balanceOf[owner] >= amount); balanceOf[owner] -= amount; asset.transfer(receiver, amount); return amount; }
}
contract Wrapped is Asset {
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external { require(balanceOf[msg.sender] >= amount); balanceOf[msg.sender] -= amount; payable(msg.sender).transfer(amount); }
}
contract Lending {
    mapping(address => mapping(address => uint256)) public supplied;
    function supply(address asset, uint256 amount, address receiver, uint16) external { Asset(asset).transferFrom(msg.sender, address(this), amount); supplied[receiver][asset] += amount; }
    function withdraw(address asset, uint256 amount, address receiver) external returns (uint256) { require(supplied[msg.sender][asset] >= amount); supplied[msg.sender][asset] -= amount; Asset(asset).transfer(receiver, amount); return amount; }
}
contract Bridge {
    event Bridged(address token, address recipient, uint256 amount);
    function bridge(address token, address receiver, uint256 amount) external payable { if (msg.value == 0) Asset(token).transferFrom(msg.sender, address(this), amount); emit Bridged(token, receiver, amount); }
}
