# @bitsocial/r9k-challenge

Robot9001-style originality challenge for Bitsocial PKC communities.

This package runs on the community node as a deterministic PKC challenge. It does not use AI. It rejects exact text reposts after Robot9001 normalization and applies escalating temporary bans for failed attempts.

## Installation

```bash
bitsocial challenge install @bitsocial/r9k-challenge
```

## Configuration

Add the challenge to an `/r9k/` community's `settings.challenges`:

```js
[
  { name: "@bitsocial/spam-blocker-challenge" },
  { name: "@bitsocial/r9k-challenge" },
];
```

Default options implement the public Robot9001 behavior:

| Option                              | Default                                 | Behavior                                                       |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `statePath`                         | `~/.bitsocial-r9k-challenge-state.json` | Private JSON state for original text hashes and temporary bans |
| `minimumOriginalContentLength`      | `16`                                    | Requires this many normalized text characters                  |
| `transgressionDecayIntervalSeconds` | `86400`                                 | Forgives one transgression per day                             |
| `penaltyBaseSeconds`                | `2`                                     | Temporary ban duration is `2^n` seconds                        |
| `maxPenaltySeconds`                 | empty                                   | No cap by default                                              |
| `blockUnicode`                      | `true`                                  | Rejects non-ASCII text                                         |
| `stripBacklinks`                    | `true`                                  | Ignores numeric backlinks like `>>123`                         |
| `requireText`                       | `true`                                  | Rejects posts without title/body text                          |
| `error`                             | `Rejected by Robot9001.`                | Error prefix shown to users                                    |

The public 4chan rule list says posts require "a certain minimum amount of original content" but does not expose the exact number. This package uses `16` normalized characters as its default and keeps it configurable per board.

## Behavior

- Exact normalized text reposts are rejected.
- Numeric backlinks like `>>1` do not count toward originality.
- Images, media links, and URLs are not included in the originality hash.
- Unicode is rejected by default.
- Posts need text; image-only posts fail.
- A failed originality attempt temporarily bans the author for `2^n` seconds, where `n` is the current transgression count.
- The transgression count decays by one every `transgressionDecayIntervalSeconds`.
- State stores SHA-256 hashes and counters, not raw post text.

## Ban Semantics

PKC exposes `author.community.banExpiresAt` for moderator bans, but a challenge failure happens before the offending comment is accepted and therefore has no accepted `commentCid` to moderate. This package enforces the same timed-ban behavior inside the challenge state and rejects the author's later challenge requests until `banExpiresAt`.

If PKC later exposes a safe challenge-side author-ban API for rejected publications, this package can map the same penalty state to native `banExpiresAt`.

## Development

```bash
corepack yarn install
corepack yarn type-check
corepack yarn test
corepack yarn build
```
