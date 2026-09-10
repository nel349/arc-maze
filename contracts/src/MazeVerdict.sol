// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice What Chainlink's forwarder calls once a report clears consensus.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice The slice of Arc's ERC-8004 ReputationRegistry this contract uses.
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

/// @title Maze Verdict
/// @notice Writes a run's score into Arc's reputation registry on behalf of a Chainlink DON.
///
/// @dev **Why this contract exists.** Until now the maze both decided a score and signed it. The
/// registry refuses only *self*-feedback, so nothing structurally stopped a seller flattering its
/// own customers — and the key that signed sat on a host we do not own.
///
/// This removes both problems at once, and it does so by removing the key rather than hiding it. A
/// Chainlink workflow re-executes the run from public evidence, the DON reaches consensus on the
/// result, and its forwarder delivers a signed report here. This contract is the `msg.sender` the
/// registry records. **There is no private key behind that address.** Nobody can sign a verdict
/// because there is nothing to sign with; the only way to write one is to convince a decentralised
/// network that a replay of the published run produces this number.
///
/// **What is deliberately fixed here rather than carried in the report.** The tags and the decimal
/// count describe what the number *means*, and a workflow that could vary them could quietly
/// relabel a score as something else. They are constants. Only the facts about a particular run
/// arrive in the report.
contract MazeVerdict is IReceiver, Ownable {
    /// @notice Arc's ERC-8004 ReputationRegistry.
    IReputationRegistry public constant REGISTRY =
        IReputationRegistry(0x8004B663056A597Dffe9eCcC1965A193B7388713);

    /// @dev Whole percent. The registry takes an integer and a decimal count; 0 keeps it readable.
    uint8 private constant VALUE_DECIMALS = 0;
    /// @dev Which game this score is from, and the unit it is in — stated on chain so a later
    /// reader never has to guess what 100 meant.
    string private constant TAG_GAME = "arc-maze";
    string private constant TAG_UNITS = "efficiency-pct";

    /// @notice The Chainlink forwarder allowed to deliver reports. Only the owner may move it.
    ///
    /// @dev Chainlink's own `ReceiverTemplate` ships `setForwarderAddress` with no access control
    /// at all, which would let anyone repoint this at themselves and then write whatever verdict
    /// they liked. Owner-gated here on purpose.
    address public forwarder;

    /// @notice Where a reader can fetch the run this score came from. Movable, because a hostname
    /// outlives neither a project nor a hosting provider, and the registry records it permanently.
    string public endpoint;

    /// @notice One verdict per run, for ever.
    ///
    /// @dev The registry has no idea what a run is, so a report delivered twice would write the
    /// score twice and an agent would be credited twice for one walk. The rule belongs here rather
    /// than in whatever process happened to answer the request: this contract is the one place
    /// every verdict must pass through, no matter how many servers or workflows exist.
    mapping(bytes32 runId => bool) public written;

    error NotTheForwarder(address caller);
    error AlreadyWritten(bytes32 runId);
    error NoForwarder();

    event VerdictWritten(bytes32 indexed runId, uint256 indexed agentId, int128 value, bytes32 feedbackHash);
    event ForwarderChanged(address indexed from, address indexed to);
    event EndpointChanged(string to);

    constructor(address forwarder_, string memory endpoint_, address owner_) Ownable(owner_) {
        forwarder = forwarder_;
        endpoint = endpoint_;
        emit ForwarderChanged(address(0), forwarder_);
        emit EndpointChanged(endpoint_);
    }

    /// @notice Point at a different forwarder, or at nobody.
    /// @dev The zero address is allowed, and is the stop: it refuses every further report while the
    /// owner works out what went wrong. Same reasoning as the badge's admitter.
    function setForwarder(address who) external onlyOwner {
        emit ForwarderChanged(forwarder, who);
        forwarder = who;
    }

    function setEndpoint(string calldata to) external onlyOwner {
        endpoint = to;
        emit EndpointChanged(to);
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata, bytes calldata report) external override {
        if (forwarder == address(0)) revert NoForwarder();
        if (msg.sender != forwarder) revert NotTheForwarder(msg.sender);

        (bytes32 runId, uint256 agentId, int128 value, string memory feedbackURI, bytes32 feedbackHash) =
            abi.decode(report, (bytes32, uint256, int128, string, bytes32));

        if (written[runId]) revert AlreadyWritten(runId);
        written[runId] = true;

        REGISTRY.giveFeedback(
            agentId, value, VALUE_DECIMALS, TAG_GAME, TAG_UNITS, endpoint, feedbackURI, feedbackHash
        );

        emit VerdictWritten(runId, agentId, value, feedbackHash);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
