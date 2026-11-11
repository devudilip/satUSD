// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title satUSD — the stablecoin, as an ERC-20 on Tachi EVM.
/// @notice Only the VaultManager can mint (against BTC locked in a TAURUS
///         vault) or burn (when debt is paid back). Everyone else can transfer
///         it like any other ERC-20.
contract SatUSD {
    string public constant name = "satUSD";
    string public constant symbol = "satUSD";
    uint8 public constant decimals = 18;

    address public immutable manager;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotManager();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address manager_) {
        manager = manager_;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) external {
        if (msg.sender != manager) revert NotManager();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external {
        if (msg.sender != manager) revert NotManager();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _move(address from, address to, uint256 value) private {
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
