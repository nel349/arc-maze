// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Cohort Zero
/// @notice A numbered badge for the first agents to solve a maze on Arc.
///
/// @dev **Why this exists next to an on-chain reputation.** The record written into Arc's
/// ReputationRegistry is what a machine reads: a score, a tag, a link to a replayable run. This is
/// the half a person screenshots. They are not redundant — one is evidence, the other is a name.
///
/// **Why the supply is fixed.** "Cohort 0" that never closes is a lie: it would mean less every
/// week and eventually nothing, which is the fate of every badge minted on a schedule. A hundred
/// closes, and anyone holding one can point at when they were early.
///
/// **What it deliberately is not.** Not transferable-for-value bait, not a governance token, not a
/// claim on anything. It says an address solved a maze while almost nobody was doing this, and it
/// is worth exactly what that is worth.
contract CohortZero is ERC721, Ownable {
    /// @notice The cohort closes here, permanently.
    uint256 public constant COHORT_SIZE = 100;

    /// @notice How many have been claimed. Also the next token id, since ids start at one.
    uint256 public minted;

    /// @notice Where metadata lives. Set once at deployment, changeable only by the owner, because
    /// a badge whose art dies with a hostname is a badge that quietly becomes a broken image.
    string private _base;

    /// @notice One badge per address: a cohort of a hundred addresses, not a hundred badges held by
    /// three of them.
    mapping(address => bool) public hasBadge;

    error CohortClosed();
    error AlreadyInCohort(address holder);

    event Admitted(address indexed holder, uint256 indexed tokenId, uint256 remaining);

    constructor(string memory baseURI, address owner_) ERC721("Cohort Zero", "COHORT0") Ownable(owner_) {
        _base = baseURI;
    }

    /// @notice Admit an address to the cohort.
    /// @dev Owner-only because the maze decides who solved a maze. An open mint would make the
    /// badge mean "was paying attention", which is not what it says on it.
    function admit(address holder) external onlyOwner returns (uint256 tokenId) {
        if (minted >= COHORT_SIZE) revert CohortClosed();
        if (hasBadge[holder]) revert AlreadyInCohort(holder);

        hasBadge[holder] = true;
        tokenId = ++minted;
        _safeMint(holder, tokenId);
        emit Admitted(holder, tokenId, COHORT_SIZE - minted);
    }

    /// @notice How many places are left. Public because "am I too late" is the only question anyone
    /// asks about a numbered thing.
    function remaining() external view returns (uint256) {
        return COHORT_SIZE - minted;
    }

    function setBaseURI(string calldata baseURI) external onlyOwner {
        _base = baseURI;
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }
}
