// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CohortZero} from "../src/CohortZero.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The badge, and the two promises its name makes.
contract CohortZeroTest is Test {
    CohortZero private badge;
    address private constant MAZE = address(0xBEEF01);
    address private constant AGENT = address(0xA6E71);

    function setUp() public {
        badge = new CohortZero("https://maze.test/badge/", MAZE);
    }

    function test_theFirstBadgeIsNumberOne() public {
        vm.prank(MAZE);
        assertEq(badge.admit(AGENT), 1);
        assertEq(badge.ownerOf(1), AGENT);
        assertEq(badge.tokenURI(1), "https://maze.test/badge/1");
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
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, AGENT));
        badge.admit(AGENT);
    }

    /// Art that dies with a hostname is a badge that quietly becomes a broken image.
    function test_theOwnerCanMoveTheMetadata() public {
        vm.startPrank(MAZE);
        badge.admit(AGENT);
        badge.setBaseURI("https://elsewhere.test/b/");
        vm.stopPrank();
        assertEq(badge.tokenURI(1), "https://elsewhere.test/b/1");
    }

    function test_anUnmintedBadgeHasNoUri() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        badge.tokenURI(1);
    }
}
