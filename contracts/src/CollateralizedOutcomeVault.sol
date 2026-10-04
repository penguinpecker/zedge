// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1155} from "../node_modules/@openzeppelin/contracts-paris/token/ERC1155/ERC1155.sol";
import {
    ERC1155Supply
} from "../node_modules/@openzeppelin/contracts-paris/token/ERC1155/extensions/ERC1155Supply.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOutcomeSettlementRegistry} from "./interfaces/IOutcomeSettlementRegistry.sol";

/// @notice Fully collateralized, PUBLIC Up/Down claims against one immutable Streams round registry.
/// @dev No owner, proxy, privileged minter, matching authority, balance attestation or withdrawal signer.
/// This is not private custody: balances, transfers, mints, burns and payouts are visible on chain.
contract CollateralizedOutcomeVault is ERC1155Supply, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfig();
    error WrongChain();
    error InvalidAmount();
    error InvalidRecipient();
    error InvalidOutcome();
    error TradingUnavailable();
    error RoundUnsettled();
    error InvalidPayout();
    error NothingToRedeem();
    error NonExactCollateralTransfer();
    error InsolventCollateral();

    event CompleteSetMinted(
        bytes32 indexed roundId, address indexed payer, address indexed recipient, uint256 amount
    );
    event CompleteSetMerged(
        bytes32 indexed roundId, address indexed holder, address indexed recipient, uint256 amount
    );
    event PositionRedeemed(
        bytes32 indexed roundId,
        address indexed holder,
        address indexed recipient,
        uint256 upAmount,
        uint256 downAmount,
        uint256 collateralAmount
    );

    uint8 public constant UP = 0;
    uint8 public constant DOWN = 1;
    uint8 public constant COLLATERAL_DECIMALS = 6;
    uint256 public constant SHARE_SCALE = 1_000_000;
    uint256 public constant SHARE_LOT = 1_000;
    // Bounds current funded liabilities independently of the token's reported totalSupply.
    uint256 public constant MAX_TOTAL_COLLATERAL = type(uint128).max;
    bytes32 private constant TOKEN_DOMAIN = keccak256("zedge-public-outcome-claim-v1");

    IOutcomeSettlementRegistry public immutable registry;
    IERC20 public immutable collateral;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable registryRulesHash;
    bytes32 public immutable registryCodeHash;
    mapping(bytes32 roundId => uint256) public collateralLocked;
    uint256 public totalCollateralLocked;

    constructor(address registry_, bytes32 expectedRulesHash_) ERC1155("") {
        if (registry_.code.length == 0 || expectedRulesHash_ == bytes32(0)) revert InvalidConfig();
        IOutcomeSettlementRegistry candidate = IOutcomeSettlementRegistry(registry_);
        address token = candidate.collateral();
        if (
            candidate.deploymentChainId() != block.chainid || candidate.rulesHash() != expectedRulesHash_
                || keccak256(bytes(candidate.version())) != keccak256("zedge-streams-round-registry-v1")
                || token.code.length == 0 || IERC20Metadata(token).decimals() != COLLATERAL_DECIMALS
        ) revert InvalidConfig();
        registry = candidate;
        collateral = IERC20(token);
        deploymentChainId = block.chainid;
        registryRulesHash = expectedRulesHash_;
        registryCodeHash = registry_.codehash;
    }

    modifier onDeploymentChain() {
        if (block.chainid != deploymentChainId) revert WrongChain();
        _;
    }

    function version() external pure returns (string memory) {
        return "zedge-public-outcome-vault-v1";
    }

    /// @notice Token IDs bind chain, vault, registry, rules, round, and outcome (0=Up, 1=Down).
    function outcomeTokenId(bytes32 roundId, uint8 outcome) public view returns (uint256) {
        if (outcome > DOWN) revert InvalidOutcome();
        return uint256(
            keccak256(
                abi.encode(
                    TOKEN_DOMAIN,
                    deploymentChainId,
                    address(this),
                    address(registry),
                    registryRulesHash,
                    roundId,
                    outcome
                )
            )
        );
    }

    /// @notice Spend caller's collateral to create equal funded Up and Down amounts for recipient.
    function mintCompleteSet(bytes32 roundId, uint256 amount, address recipient)
        external
        nonReentrant
        onDeploymentChain
    {
        _checkRecipient(recipient);
        _checkAmount(amount);
        if (!registry.canTrade(roundId)) revert TradingUnavailable();
        _checkSolvent();
        if (amount > MAX_TOTAL_COLLATERAL - totalCollateralLocked) revert InvalidAmount();

        collateralLocked[roundId] += amount;
        totalCollateralLocked += amount;
        _pullExact(msg.sender, amount);
        (uint256[] memory ids, uint256[] memory amounts) = _pair(roundId, amount, amount);
        _mintBatch(recipient, ids, amounts, "");
        _checkSolvent();
        emit CompleteSetMinted(roundId, msg.sender, recipient, amount);
    }

    /// @notice A funded pair always pays one collateral unit, including after cutoff or settlement.
    /// @dev Only caller-owned shares may be burned. ERC1155 approval is not redemption authority.
    function mergeCompleteSet(bytes32 roundId, uint256 amount, address recipient)
        external
        nonReentrant
        onDeploymentChain
    {
        _checkRecipient(recipient);
        _checkAmount(amount);
        _checkSolvent();
        (uint256[] memory ids, uint256[] memory amounts) = _pair(roundId, amount, amount);
        collateralLocked[roundId] -= amount;
        totalCollateralLocked -= amount;
        _burnBatch(msg.sender, ids, amounts);
        _pushExact(recipient, amount);
        _checkSolvent();
        emit CompleteSetMerged(roundId, msg.sender, recipient, amount);
    }

    /// @notice Burn all caller-owned shares for this round and pay its immutable settled ratio.
    /// @dev Void halves are exact because mint, burn and transfer quantities are multiples of 1000.
    function redeem(bytes32 roundId, address recipient)
        external
        nonReentrant
        onDeploymentChain
        returns (uint256 payout)
    {
        _checkRecipient(recipient);
        _checkSolvent();
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(roundId);
        if (up == 0 && down == 0 && denominator == 0) revert RoundUnsettled();
        if (denominator != 2 || up > 2 || down > 2 || uint256(up) + down != 2) {
            revert InvalidPayout();
        }
        uint256 upAmount = balanceOf(msg.sender, outcomeTokenId(roundId, UP));
        uint256 downAmount = balanceOf(msg.sender, outcomeTokenId(roundId, DOWN));
        if (upAmount == 0 && downAmount == 0) revert NothingToRedeem();
        // Only the three ratios above are possible. Each void half is exact under SHARE_LOT.
        payout = up == 2 ? upAmount : (down == 2 ? downAmount : upAmount / 2 + downAmount / 2);
        (uint256[] memory ids, uint256[] memory amounts) = _pair(roundId, upAmount, downAmount);
        collateralLocked[roundId] -= payout;
        totalCollateralLocked -= payout;
        _burnBatch(msg.sender, ids, amounts);
        if (payout != 0) _pushExact(recipient, payout);
        _checkSolvent();
        emit PositionRedeemed(roundId, msg.sender, recipient, upAmount, downAmount, payout);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes memory data)
        public
        override
        nonReentrant
        onDeploymentChain
    {
        super.safeTransferFrom(from, to, id, value, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) public override nonReentrant onDeploymentChain {
        super.safeBatchTransferFrom(from, to, ids, values, data);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        for (uint256 i; i < values.length; ++i) {
            if (values[i] % SHARE_LOT != 0) revert InvalidAmount();
        }
        super._update(from, to, ids, values);
    }

    function _pair(bytes32 roundId, uint256 up, uint256 down)
        private
        view
        returns (uint256[] memory ids, uint256[] memory amounts)
    {
        ids = new uint256[](2);
        amounts = new uint256[](2);
        ids[0] = outcomeTokenId(roundId, UP);
        ids[1] = outcomeTokenId(roundId, DOWN);
        amounts[0] = up;
        amounts[1] = down;
    }

    function _checkAmount(uint256 amount) private pure {
        if (amount == 0 || amount > MAX_TOTAL_COLLATERAL || amount % SHARE_LOT != 0) {
            revert InvalidAmount();
        }
    }

    function _checkRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
    }

    function _checkSolvent() private view {
        if (collateral.balanceOf(address(this)) < totalCollateralLocked) revert InsolventCollateral();
    }

    function _pullExact(address payer, uint256 amount) private {
        uint256 vaultBefore = collateral.balanceOf(address(this));
        uint256 payerBefore = collateral.balanceOf(payer);
        if (payerBefore < amount) revert NonExactCollateralTransfer();
        collateral.safeTransferFrom(payer, address(this), amount);
        if (
            collateral.balanceOf(address(this)) != vaultBefore + amount
                || collateral.balanceOf(payer) != payerBefore - amount
        ) revert NonExactCollateralTransfer();
    }

    function _pushExact(address recipient, uint256 amount) private {
        uint256 vaultBefore = collateral.balanceOf(address(this));
        uint256 recipientBefore = collateral.balanceOf(recipient);
        if (vaultBefore < amount) revert InsolventCollateral();
        collateral.safeTransfer(recipient, amount);
        if (
            collateral.balanceOf(address(this)) != vaultBefore - amount
                || collateral.balanceOf(recipient) != recipientBefore + amount
        ) revert NonExactCollateralTransfer();
    }
}
