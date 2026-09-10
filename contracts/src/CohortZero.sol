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
///
/// **Why minting and governing are separate powers.** The maze runs on a host we do not own, and it
/// needs to mint the moment a run is solved — nobody wants a badge that arrives when an operator
/// next remembers to issue it. But minting is all it needs. Welding that to `onlyOwner`, as this
/// contract first did, meant the server also held the power to repoint every badge's art and to
/// hand the contract away. So `admitter` is its own role: it mints and can do nothing else, and the
/// owner key that governs never has to go near a server again.
///
/// The role is also a seam. When the verdict is re-executed by a network and signed inside an
/// enclave, minting moves there with one `setAdmitter` call rather than a redeployment.
contract CohortZero is ERC721, Ownable {
    /// @notice The cohort closes here, permanently.
    uint256 public constant COHORT_SIZE = 100;

    /// @notice The only address that can admit anyone. Set by the owner, and nothing else.
    ///
    /// @dev Deliberately allowed to be the zero address, which is the emergency stop: if the
    /// admitter key leaks, the owner halts every further mint in one transaction and rotates
    /// afterwards. Rejecting zero would trade that for protection against a typo the owner can
    /// already undo.
    address public admitter;

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
    error NotTheMaze(address caller);

    event Admitted(address indexed holder, uint256 indexed tokenId, uint256 remaining);
    event AdmitterChanged(address indexed from, address indexed to);

    /// @dev The admitter is set at construction rather than defaulted to the owner, so there is
    /// never a moment — not even one block — where the governing key is also the minting key.
    constructor(string memory baseURI, address owner_, address admitter_)
        ERC721("Cohort Zero", "COHORT0")
        Ownable(owner_)
    {
        _base = baseURI;
        admitter = admitter_;
        emit AdmitterChanged(address(0), admitter_);
    }

    modifier onlyAdmitter() {
        if (msg.sender != admitter) revert NotTheMaze(msg.sender);
        _;
    }

    /// @notice Point the badge at a different minter, or at nobody.
    /// @dev The owner's power over the cohort, and the whole reason the owner key can stay offline.
    function setAdmitter(address who) external onlyOwner {
        emit AdmitterChanged(admitter, who);
        admitter = who;
    }

    /// @notice Admit an address to the cohort.
    /// @dev Restricted because the maze decides who solved a maze. An open mint would make the
    /// badge mean "was paying attention", which is not what it says on it.
    function admit(address holder) external onlyAdmitter returns (uint256 tokenId) {
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
