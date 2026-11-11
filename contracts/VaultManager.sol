// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISatUSD {
    function mint(address to, uint256 value) external;
    function burn(address from, uint256 value) external;
}

/// @title VaultManager — the satUSD CDP book on Tachi EVM.
/// @notice The BTC collateral never enters the EVM: it sits in a TAURUS vault
///         on Bitcoin (owner MuSig2 key + 5-of-7 Tachi validators, with a
///         timelocked exit for the owner). This contract holds the *debt*
///         side and enforces the risk rules on-chain:
///           - satUSD can only be minted while the vault stays >= 150%,
///           - a vault can only be marked liquidated below 130%,
///           - only the vault owner can pay its debt back (burning satUSD),
///           - a vault can only be closed with zero debt.
///         The operator (the satUSD engine) attests to the Bitcoin side —
///         that the deposit confirmed, and which Bitcoin txid liquidated,
///         closed or exited the vault — and runs the dev price oracle.
contract VaultManager {
    enum Status { None, Open, Liquidated, Closed, Exited }

    struct Vault {
        address owner;
        Status status;
        uint64 collateralSats;
        uint256 debtCents;
        bytes32 btcVaultKey;   // TAURUS vault P2TR output key
        bytes32 depositTxid;   // Bitcoin tx that funded the vault
        bytes32 liquidationTxid; // pre-signed Bitcoin liquidation tx for the current debt
        bytes32 settleTxid;    // Bitcoin tx that liquidated / closed / exited it
    }

    uint256 public constant MIN_RATIO_BPS = 15_000; // 150% to mint
    uint256 public constant LIQUIDATION_RATIO_BPS = 13_000; // liquidatable below 130%
    uint256 public constant PENALTY_BPS = 800; // 8%
    uint256 private constant CENT = 1e16; // 1 cent in satUSD base units (18 decimals)

    address public immutable operator;
    ISatUSD public immutable satUSD;
    uint256 public priceCents; // USD cents per 1 BTC
    uint256 public totalDebtCents;
    bytes32[] public vaultIds;
    mapping(bytes32 => Vault) public vaults;

    event PriceUpdated(uint256 priceCents);
    event VaultOpened(bytes32 indexed id, address indexed owner, uint64 collateralSats, bytes32 btcVaultKey, bytes32 depositTxid);
    event Generated(bytes32 indexed id, uint256 amountCents, uint256 debtCents, bytes32 liquidationTxid);
    event PaidBack(bytes32 indexed id, uint256 amountCents, uint256 debtCents);
    event LiquidationTxUpdated(bytes32 indexed id, bytes32 liquidationTxid);
    event Liquidated(bytes32 indexed id, uint256 debtCents, uint256 ratioBps, uint256 lenderShareCents, bytes32 btcTxid);
    event Closed(bytes32 indexed id, bytes32 btcTxid);
    event Exited(bytes32 indexed id, uint256 debtCents, bytes32 btcTxid);

    error NotOperator();
    error NotOwner();
    error NotOpen();
    error AlreadyExists();
    error BelowMinRatio(uint256 ratioBps);
    error NotLiquidatable(uint256 ratioBps);
    error DebtOutstanding(uint256 debtCents);
    error TooMuch();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address satUSD_, uint256 priceCents_) {
        operator = msg.sender;
        satUSD = ISatUSD(satUSD_);
        priceCents = priceCents_;
        emit PriceUpdated(priceCents_);
    }

    // ---------- oracle ----------

    function setPrice(uint256 priceCents_) external onlyOperator {
        priceCents = priceCents_;
        emit PriceUpdated(priceCents_);
    }

    // ---------- vault lifecycle ----------

    /// @notice Record a vault whose BTC deposit has confirmed on Bitcoin.
    function openVault(bytes32 id, address owner, uint64 collateralSats, bytes32 btcVaultKey, bytes32 depositTxid)
        external
        onlyOperator
    {
        if (vaults[id].status != Status.None) revert AlreadyExists();
        vaults[id] = Vault(owner, Status.Open, collateralSats, 0, btcVaultKey, depositTxid, bytes32(0), bytes32(0));
        vaultIds.push(id);
        emit VaultOpened(id, owner, collateralSats, btcVaultKey, depositTxid);
    }

    /// @notice Mint satUSD to the vault owner. Called once the new Bitcoin
    ///         liquidation state for the higher debt is co-signed.
    function generate(bytes32 id, uint256 amountCents, bytes32 liquidationTxid) external onlyOperator {
        Vault storage v = _open(id);
        uint256 debt = v.debtCents + amountCents;
        uint256 ratio = _ratioBps(v.collateralSats, debt);
        if (ratio < MIN_RATIO_BPS) revert BelowMinRatio(ratio);
        v.debtCents = debt;
        v.liquidationTxid = liquidationTxid;
        totalDebtCents += amountCents;
        satUSD.mint(v.owner, amountCents * CENT);
        emit Generated(id, amountCents, debt, liquidationTxid);
    }

    /// @notice The owner burns their satUSD to reduce the vault's debt.
    function payBack(bytes32 id, uint256 amountCents) external {
        Vault storage v = _open(id);
        if (msg.sender != v.owner) revert NotOwner();
        if (amountCents > v.debtCents) revert TooMuch();
        satUSD.burn(msg.sender, amountCents * CENT);
        v.debtCents -= amountCents;
        totalDebtCents -= amountCents;
        emit PaidBack(id, amountCents, v.debtCents);
    }

    /// @notice After a pay back the Bitcoin liquidation state is re-signed for
    ///         the lower debt; record the new pre-signed txid.
    function updateLiquidationTx(bytes32 id, bytes32 liquidationTxid) external onlyOperator {
        Vault storage v = _open(id);
        v.liquidationTxid = liquidationTxid;
        emit LiquidationTxUpdated(id, liquidationTxid);
    }

    /// @notice Record a liquidation. Reverts unless the vault really is below 130%
    ///         at the on-chain price.
    function liquidate(bytes32 id, bytes32 btcTxid) external onlyOperator {
        Vault storage v = _open(id);
        uint256 ratio = _ratioBps(v.collateralSats, v.debtCents);
        if (ratio >= LIQUIDATION_RATIO_BPS) revert NotLiquidatable(ratio);
        uint256 debt = v.debtCents;
        v.status = Status.Liquidated;
        v.settleTxid = btcTxid;
        v.debtCents = 0;
        totalDebtCents -= debt;
        emit Liquidated(id, debt, ratio, (debt * (10_000 + PENALTY_BPS)) / 10_000, btcTxid);
    }

    /// @notice Record a cooperative close. Only with all debt repaid.
    function close(bytes32 id, bytes32 btcTxid) external onlyOperator {
        Vault storage v = _open(id);
        if (v.debtCents != 0) revert DebtOutstanding(v.debtCents);
        v.status = Status.Closed;
        v.settleTxid = btcTxid;
        emit Closed(id, btcTxid);
    }

    /// @notice Record the owner's unilateral exit after the timelock.
    function recordExit(bytes32 id, bytes32 btcTxid) external onlyOperator {
        Vault storage v = _open(id);
        uint256 debt = v.debtCents;
        v.status = Status.Exited;
        v.settleTxid = btcTxid;
        v.debtCents = 0;
        totalDebtCents -= debt;
        emit Exited(id, debt, btcTxid);
    }

    // ---------- views ----------

    function collateralRatioBps(bytes32 id) external view returns (uint256) {
        Vault storage v = vaults[id];
        return _ratioBps(v.collateralSats, v.debtCents);
    }

    function vaultCount() external view returns (uint256) {
        return vaultIds.length;
    }

    function _open(bytes32 id) private view returns (Vault storage v) {
        v = vaults[id];
        if (v.status != Status.Open) revert NotOpen();
    }

    function _ratioBps(uint64 sats, uint256 debtCents) private view returns (uint256) {
        if (debtCents == 0) return type(uint256).max;
        return (uint256(sats) * priceCents * 10_000) / (debtCents * 1e8);
    }
}
