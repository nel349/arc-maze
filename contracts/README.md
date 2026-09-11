# Contracts

Two contracts for Arc testnet (chain 5042002), built and tested with [Foundry](https://getfoundry.sh).

| Contract | What it does | On chain |
|---|---|---|
| [`CohortZero.sol`](src/CohortZero.sol) | The Cohort Zero badge: an ERC-721 of a hundred places, one per address. Minting and governing are separate powers. Only the admitter may admit; only the owner may change the admitter or where the badge's details live. | [`0xe5a8…3a53`](https://testnet.arcscan.app/token/0xe5a8faef7139d04582c7e17c3f615710343b53a3) |
| [`MazeVerdict.sol`](src/MazeVerdict.sol) | Writes a run's score into Arc's ERC-8004 reputation registry on behalf of a Chainlink DON, so no private key authors the score. It takes reports only from Chainlink's forwarder, and scores each run once. | not deployed yet; see [`../cre/README.md`](../cre/README.md) |

## Test

```sh
forge test                # from here
bun run test:contracts    # or from the repository root
```

On a fresh clone the first run fetches the dependencies, OpenZeppelin included.

## Deploy the badge

`bun scripts/deploy-badge.ts`, from the repository root, prints what it would deploy and sends
nothing. `--send` executes it, and `--fresh` opens an empty cohort. Its header explains both, and why
the key that governs the badge stays off the server.
