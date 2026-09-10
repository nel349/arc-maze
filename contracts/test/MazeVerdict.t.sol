// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MazeVerdict, IReceiver, IERC165} from "../src/MazeVerdict.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Records what the registry was asked to write, so the test can read it back.
contract RegistrySpy {
    uint256 public agentId;
    int128 public value;
    uint8 public valueDecimals;
    string public tag1;
    string public tag2;
    string public endpoint;
    string public feedbackURI;
    bytes32 public feedbackHash;
    uint256 public calls;
    address public lastCaller;

    function giveFeedback(
        uint256 agentId_,
        int128 value_,
        uint8 valueDecimals_,
        string calldata tag1_,
        string calldata tag2_,
        string calldata endpoint_,
        string calldata feedbackURI_,
        bytes32 feedbackHash_
    ) external {
        agentId = agentId_;
        value = value_;
        valueDecimals = valueDecimals_;
        tag1 = tag1_;
        tag2 = tag2_;
        endpoint = endpoint_;
        feedbackURI = feedbackURI_;
        feedbackHash = feedbackHash_;
        lastCaller = msg.sender;
        calls++;
    }
}

/// @notice The contract that writes a verdict nobody holds a key for.
contract MazeVerdictTest is Test {
    MazeVerdict private verdict;
    RegistrySpy private spy;

    address private constant OWNER = address(0x0FF1CE);
    address private constant FORWARDER = address(0xF0);
    address private constant STRANGER = address(0x5A1);

    bytes32 private constant RUN = keccak256("7936b331-e246-4a30-b67a-4d555f033a4b");
    uint256 private constant AGENT = 892655;
    bytes32 private constant HASH = bytes32(uint256(0xE033BF88));
    string private constant URL = "https://arc-maze.vercel.app/run/7936b331";

    function setUp() public {
        verdict = new MazeVerdict(FORWARDER, "https://arc-maze.vercel.app", OWNER);
        // The registry is a constant address on Arc, so the spy is placed at it.
        spy = new RegistrySpy();
        vm.etch(address(verdict.REGISTRY()), address(spy).code);
        spy = RegistrySpy(address(verdict.REGISTRY()));
    }

    function _report(bytes32 runId, uint256 agentId, int128 value) private pure returns (bytes memory) {
        return abi.encode(runId, agentId, value, URL, HASH);
    }

    function test_theForwarderCanWriteAVerdict() public {
        vm.prank(FORWARDER);
        verdict.onReport("", _report(RUN, AGENT, 100));

        assertEq(spy.calls(), 1);
        assertEq(spy.agentId(), AGENT);
        assertEq(spy.value(), int128(100));
        assertEq(spy.feedbackHash(), HASH);
        assertEq(spy.feedbackURI(), URL);
    }

    /// The whole point: the registry sees this contract, not a person.
    ///
    /// There is no private key behind this address. A verdict cannot be signed into existence — the
    /// only route is a report a decentralised network agreed on.
    function test_theRegistrySeesTheContractAsTheAuthor() public {
        vm.prank(FORWARDER);
        verdict.onReport("", _report(RUN, AGENT, 100));
        assertEq(spy.lastCaller(), address(verdict));
        assertTrue(spy.lastCaller() != FORWARDER);
        assertTrue(spy.lastCaller() != OWNER);
    }

    /// What the number means is fixed in the contract, so a workflow cannot relabel a score.
    function test_theUnitsAreNotTheWorkflowsToChoose() public {
        vm.prank(FORWARDER);
        verdict.onReport("", _report(RUN, AGENT, 100));
        assertEq(spy.tag1(), "arc-maze");
        assertEq(spy.tag2(), "efficiency-pct");
        assertEq(spy.valueDecimals(), 0);
        assertEq(spy.endpoint(), "https://arc-maze.vercel.app");
    }

    function test_onlyTheForwarderIsHeard() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(MazeVerdict.NotTheForwarder.selector, STRANGER));
        verdict.onReport("", _report(RUN, AGENT, 100));

        // Not even the owner, who can move the forwarder but cannot be one.
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MazeVerdict.NotTheForwarder.selector, OWNER));
        verdict.onReport("", _report(RUN, AGENT, 100));
        assertEq(spy.calls(), 0);
    }

    /// One walk, one score.
    ///
    /// The registry has no idea what a run is, so a report delivered twice would credit an agent
    /// twice for the same walk. Two servers, two workflows, or one retry all arrive here.
    function test_aRunIsScoredOnce() public {
        vm.startPrank(FORWARDER);
        verdict.onReport("", _report(RUN, AGENT, 100));
        vm.expectRevert(abi.encodeWithSelector(MazeVerdict.AlreadyWritten.selector, RUN));
        verdict.onReport("", _report(RUN, AGENT, 42));
        vm.stopPrank();

        assertEq(spy.calls(), 1);
        // And the first answer stands: a replay cannot overwrite a score with a different one.
        assertEq(spy.value(), int128(100));
    }

    function test_adifferentRunIsStillWelcome() public {
        vm.startPrank(FORWARDER);
        verdict.onReport("", _report(RUN, AGENT, 100));
        verdict.onReport("", _report(keccak256("another"), AGENT, 75));
        vm.stopPrank();
        assertEq(spy.calls(), 2);
        assertEq(spy.value(), int128(75));
    }

    function test_theOwnerCanMoveTheForwarder() public {
        vm.prank(OWNER);
        verdict.setForwarder(STRANGER);
        assertEq(verdict.forwarder(), STRANGER);

        vm.prank(STRANGER);
        verdict.onReport("", _report(RUN, AGENT, 100));
        assertEq(spy.calls(), 1);

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(MazeVerdict.NotTheForwarder.selector, FORWARDER));
        verdict.onReport("", _report(keccak256("x"), AGENT, 1));
    }

    /// Chainlink's own template ships this setter ungated. That would let anyone point the contract
    /// at themselves and write any verdict they liked.
    function test_aStrangerCannotAppointThemselvesTheForwarder() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        verdict.setForwarder(STRANGER);
    }

    /// The stop, for when something is wrong and nobody yet knows what.
    function test_theOwnerCanRefuseEveryReport() public {
        vm.prank(OWNER);
        verdict.setForwarder(address(0));

        vm.prank(FORWARDER);
        vm.expectRevert(MazeVerdict.NoForwarder.selector);
        verdict.onReport("", _report(RUN, AGENT, 100));
        assertEq(spy.calls(), 0);
    }

    /// A hostname outlives neither a project nor a hosting provider, and this one is written into
    /// every record permanently.
    function test_theEndpointCanMoveAndOnlyTheOwnerMovesIt() public {
        vm.prank(OWNER);
        verdict.setEndpoint("https://toll.example");
        vm.prank(FORWARDER);
        verdict.onReport("", _report(RUN, AGENT, 100));
        assertEq(spy.endpoint(), "https://toll.example");

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        verdict.setEndpoint("https://attacker.example");
    }

    /// The forwarder checks this before it will deliver anything at all.
    function test_itAnnouncesItselfAsAReceiver() public view {
        assertTrue(verdict.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(verdict.supportsInterface(type(IERC165).interfaceId));
        assertFalse(verdict.supportsInterface(bytes4(0xdeadbeef)));
    }
}
