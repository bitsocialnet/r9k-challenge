[![Coverage](https://img.shields.io/endpoint?url=https://bitsocialnet.github.io/r9k-challenge/badges/coverage.json)](https://github.com/bitsocialnet/r9k-challenge/blob/master/scripts/write-coverage-badge.mjs)

# @bitsocial/r9k-challenge

Robot9000-style originality challenge for Bitsocial communities.

This package runs on a Bitsocial community owner node as a deterministic Bitsocial challenge. It is not specific to 5chan; any Bitsocial community can use it when the operator wants Robot9000-style anti-repost behavior. It does not use AI. It scans the community owner's local comments database for exact text reposts after Robot9000 normalization and applies escalating temporary bans for failed attempts.

Robot9000 is based on the anti-repost idea originally described by Randall Munroe in [ROBOT9000 and #xkcd-signal: Attacking Noise in Chat](https://blog.xkcd.com/2008/01/14/robot9000-and-xkcd-signal-attacking-noise-in-chat/).

## Installation

Run this on the Bitsocial node that owns the community:

```bash
bitsocial challenge install @bitsocial/r9k-challenge
```

This challenge is listed in the Bitsocial app directory under anti-spam:

https://bitsocial.net/apps?category=anti-spam

## Configuration

Add the challenge to the community's `settings.challenges`:

```js
[
  { name: "@bitsocial/spam-blocker-challenge" },
  { name: "@bitsocial/r9k-challenge" },
];
```

Default options implement Robot9000-style behavior:

| Option                              | Default                                 | Behavior                                                            |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `statePath`                         | `~/.bitsocial-r9k-challenge-state.json` | Private JSON state for temporary bans and accepted-hash race guards |
| `minimumOriginalContentLength`      | `16`                                    | Requires this many normalized text characters                       |
| `transgressionDecayIntervalSeconds` | `86400`                                 | Forgives one transgression per day                                  |
| `penaltyBaseSeconds`                | `2`                                     | Temporary ban duration is `2^n` seconds                             |
| `maxPenaltySeconds`                 | empty                                   | No cap by default                                                   |
| `blockUnicode`                      | `true`                                  | Rejects non-ASCII text                                              |
| `stripBacklinks`                    | `true`                                  | Ignores numeric backlinks like `>>123`                              |
| `requireText`                       | `true`                                  | Rejects posts without title/body text                               |
| `error`                             | `Rejected by Robot9000.`                | Error prefix shown to users                                         |

Posts require enough original content to avoid low-effort duplicates. This package uses `16` normalized characters as its default and keeps it configurable per board.

## Behavior

- Exact normalized text reposts are rejected by scanning the owner node's `comments` SQLite table during `getChallenge()`.
- Numeric backlinks like `>>1` do not count toward originality.
- Images, media links, and URLs are not included in the originality hash.
- Unicode is rejected by default.
- Posts need text; image-only posts fail.
- A failed originality attempt temporarily bans the author for `2^n` seconds, where `n` is the current transgression count.
- The transgression count decays by one every `transgressionDecayIntervalSeconds`.
- State stores SHA-256 hashes for newly accepted text plus temporary-ban counters, not raw post text. Existing-board originality comes from the local database scan.

## Ban Semantics

Bitsocial exposes `author.community.banExpiresAt` for moderator bans, but a challenge failure happens before the offending comment is accepted and therefore has no accepted `commentCid` to moderate. This package enforces the same timed-ban behavior inside the challenge state and rejects the author's later challenge requests until `banExpiresAt`.

If Bitsocial later exposes a safe challenge-side author-ban API for rejected publications, this package can map the same penalty state to native `banExpiresAt`.

## Development

```bash
corepack yarn install
corepack yarn type-check
corepack yarn test
corepack yarn test:coverage
corepack yarn build
```

## Test Coverage

The test suite covers Robot9000 normalization, minimum text checks, Unicode blocking, image/link exclusion, escalating and decaying temporary bans, content edits, missing database fail-closed behavior, and duplicate detection against both the challenge state file and a real in-memory SQLite `comments`/`commentUpdates` database.

The coverage badge reports line coverage generated with `yarn test:coverage`. On pushes to `master`, CI writes a Shields-compatible endpoint payload and publishes it to GitHub Pages.

These tests exercise the challenge package directly. They do not start a full Bitsocial node or publish over the network.

## Publishing

Create the GitHub release and changelog with release-it:

```bash
corepack yarn release 0.1.0
```

The command expects the current branch to have an upstream and needs a GitHub token that can create releases. It writes `CHANGELOG.md`, creates a `v0.1.0` tag, and opens the GitHub release.

The first npm publish must create the package before trusted publishing can be configured:

```bash
npm publish --access public
```

After the package exists, configure npm trusted publishing:

- Publisher: GitHub Actions
- Organization: `bitsocialnet`
- Repository: `r9k-challenge`
- Workflow filename: `publish.yml`
- Environment: leave blank

Equivalent npm CLI command:

```bash
npm trust github @bitsocial/r9k-challenge --repo bitsocialnet/r9k-challenge --file publish.yml
```

Future releases publish automatically when `package.json` version changes on `master`. The publish workflow skips versions that already exist on npm.
