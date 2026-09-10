// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CohortZero} from "../src/CohortZero.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The badge, the two promises its name makes, and the split between minting and governing.
contract CohortZeroTest is Test {
    CohortZero private badge;

    /// The key that governs. It never goes near a server, which is the point of every test below
    /// that asserts what it cannot do.
    address private constant OWNER = address(0x0FF1CE);
    /// The key the maze runs with. It mints, and that is the whole of its power.
    address private constant MAZE = address(0xBEEF01);
    address private constant AGENT = address(0xA6E71);
    address private constant STRANGER = address(0x5A1);

    function setUp() public {
        badge = new CohortZero("https://maze.test/badge/", OWNER, MAZE);
    }

    function test_theFirstBadgeIsNumberOne() public {
        vm.prank(MAZE);
        assertEq(badge.admit(AGENT), 1);
        assertEq(badge.ownerOf(1), AGENT);
        assertEq(badge.tokenURI(1), "https://maze.test/badge/1");
    }

    /// A hundred, written out.
    ///
    /// Every other test asks the contract for `COHORT_SIZE()` — right for them, and it leaves
    /// nothing holding the number itself: setting the constant to 101 moved the cohort and the
    /// whole suite stayed green. The size is not an implementation detail. It is on the badge, in
    /// the README, and in what the word "cohort" promises, so one test states it as a literal.
    function test_theCohortIsAHundred() public view {
        assertEq(badge.COHORT_SIZE(), 100);
    }

    /// The promise in the name: it closes. A cohort that never closes means less every week.
    function test_theCohortCloses() public {
        for (uint256 i = 0; i < badge.COHORT_SIZE(); i++) {
            vm.prank(MAZE);
            badge.admit(address(uint160(1000 + i)));
        }
        assertEq(badge.remaining(), 0);
        vm.prank(MAZE);
        vm.expectRevert(CohortZero.CohortClosed.selector);
        badge.admit(AGENT);
    }

    /// The other promise: a hundred addresses, not a hundred badges held by three of them.
    function test_oneBadgePerAddress() public {
        vm.startPrank(MAZE);
        badge.admit(AGENT);
        vm.expectRevert(abi.encodeWithSelector(CohortZero.AlreadyInCohort.selector, AGENT));
        badge.admit(AGENT);
        vm.stopPrank();
    }

    /// The maze decides who solved a maze. An open mint would make this say "was paying attention".
    function test_onlyTheMazeAdmits() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(CohortZero.NotTheMaze.selector, STRANGER));
        badge.admit(AGENT);
    }

    // ---- minting and governing are different powers -----------------------------------------

    /// The reason this contract was redeployed.
    ///
    /// Not a formality: the first version welded `admit` to `onlyOwner`, so the server that had to
    /// mint on every solve also held the power to repoint every badge's art and hand the contract
    /// away. Minting is the job. Owning is not, and the owner does not get it back by being the
    /// owner — otherwise the key on the server would still be the key that governs.
    function test_theOwnerCannotMint() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(CohortZero.NotTheMaze.selector, OWNER));
        badge.admit(AGENT);
    }

    /// And the minter cannot govern: neither half of the split leaks into the other.
    function test_theMazeCannotGovern() public {
        vm.startPrank(MAZE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, MAZE));
        badge.setBaseURI("https://attacker.test/b/");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, MAZE));
        badge.setAdmitter(STRANGER);
        vm.stopPrank();
    }

    /// The seam. When the verdict is signed somewhere we cannot reach, minting moves there in one
    /// transaction — and the address it moved away from loses the power in the same transaction.
    function test_theOwnerCanMoveTheMintElsewhere() public {
        vm.prank(OWNER);
        vm.expectEmit(true, true, false, false);
        emit CohortZero.AdmitterChanged(MAZE, STRANGER);
        badge.setAdmitter(STRANGER);

        assertEq(badge.admitter(), STRANGER);

        vm.prank(STRANGER);
        assertEq(badge.admit(AGENT), 1);

        vm.prank(MAZE);
        vm.expectRevert(abi.encodeWithSelector(CohortZero.NotTheMaze.selector, MAZE));
        badge.admit(STRANGER);
    }

    /// The emergency stop, and why zero is allowed rather than rejected.
    ///
    /// A leaked minting key is the failure this role exists to survive. The owner halts every
    /// further mint in one transaction from a key that was never on a server, and rotates when
    /// there is time to do it properly.
    function test_theOwnerCanStopMintingAltogether() public {
        vm.prank(OWNER);
        badge.setAdmitter(address(0));

        vm.prank(MAZE);
        vm.expectRevert(abi.encodeWithSelector(CohortZero.NotTheMaze.selector, MAZE));
        badge.admit(AGENT);

        // Halted, not bricked: the cohort is untouched and the owner can hand minting back.
        assertEq(badge.remaining(), badge.COHORT_SIZE());
        vm.prank(OWNER);
        badge.setAdmitter(MAZE);
        vm.prank(MAZE);
        assertEq(badge.admit(AGENT), 1);
    }

    /// There is never a block in which the governing key is also the minting key.
    function test_theTwoRolesAreNeverTheSameAddress() public view {
        assertEq(badge.owner(), OWNER);
        assertEq(badge.admitter(), MAZE);
        assertTrue(badge.owner() != badge.admitter());
    }

    /// A stranger cannot appoint themselves.
    function test_onlyTheOwnerMovesTheMint() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        badge.setAdmitter(STRANGER);
    }

    // ---- metadata ----------------------------------------------------------------------------

    /// Art that dies with a hostname is a badge that quietly becomes a broken image.
    function test_theOwnerCanMoveTheMetadata() public {
        vm.prank(MAZE);
        badge.admit(AGENT);
        vm.prank(OWNER);
        badge.setBaseURI("https://elsewhere.test/b/");
        assertEq(badge.tokenURI(1), "https://elsewhere.test/b/1");
    }

    /// And nobody else can.
    ///
    /// The other half of the test above, which was missing: `setBaseURI` moves the art for *every*
    /// badge at once, so an ungated one would let a stranger repoint the whole cohort's images at
    /// anything they liked. Removing `onlyOwner` from it left the suite green.
    function test_onlyTheOwnerCanMoveTheMetadata() public {
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, AGENT));
        badge.setBaseURI("https://attacker.test/b/");
    }

    function test_anUnmintedBadgeHasNoUri() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        badge.tokenURI(1);
    }
}
