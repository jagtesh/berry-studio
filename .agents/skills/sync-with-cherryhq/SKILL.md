---
name: sync-with-cherryhq
description: Rebase this Berry Studio checkout onto CherryHQ/cherry-studio main when asked to sync with CherryHQ, update from upstream, or rebase onto the latest upstream main. Preserve local commits and signing; pushing is separate.
---

# Sync with CherryHQ

“Sync with CherryHQ” means rebase the current branch onto the latest `main` from
**CherryHQ/cherry-studio**. `origin` is the Berry Studio fork; its `main` is not
proof that this checkout is current with CherryHQ.

## Fetch the correct upstream

1. Read local instructions, inspect `git status`, the current branch, and remote
   URLs. Finish or resolve any existing Git operation before starting another.
   Preserve uncommitted work; do not discard it or create commits merely to make
   the tree clean. Use an existing authorization to stash if applicable; otherwise
   ask how to handle edits that would prevent the rebase.
2. Verify that `upstream` points to `CherryHQ/cherry-studio` (SSH or HTTPS).
   If absent, add it with `git remote add upstream git@github.com:CherryHQ/cherry-studio.git`.
   If that name belongs to another repository, preserve it and use a verified
   `cherryhq` remote instead. Leave `origin` and branch push/tracking settings intact.
3. Fetch `main` from that verified remote. Use its fetched remote-tracking ref
   explicitly in all following commands; examples below assume `upstream/main`.
   If fetching fails, report the failure rather than calling cached refs current.
4. Record the original HEAD, fetched upstream SHA, original merge base, and local
   commit list. Show `git rev-list --left-right --count upstream/main...HEAD`.
   If already based on that fetched tip, report that fact without rewriting commits.

## Rebase local work

- Run `git rebase --gpg-sign upstream/main`. Use the existing signing identity;
  when necessary, supply per-command signing configuration rather than changing
  global settings. Do not generate replacement keys or downgrade to unsigned commits.
- Resolve conflicts by preserving upstream behavior and the local change's intent.
  Read current code and nearby documentation before editing. Continue with signing
  enabled; preserve DCO `Signed-off-by` trailers. Do not silently skip local commits;
  explain any change already incorporated upstream.
- Allow repository checkout/install hooks to finish before starting validation.
  Dependency updates may temporarily make test executables unavailable. If a hook
  fails, inspect Git's state before continuing; do not start a second rebase.

## Verify and report

1. Verify `git merge-base --is-ancestor upstream/main HEAD`, inspect the final
   local commit list, and check `git status`. Compare the old and new patch series
   with `git range-diff <old-base>..<old-head> upstream/main..HEAD`; explain changes
   introduced by conflict resolution or commits absorbed by upstream.
2. Verify each rewritten commit has a `gpgsig` header and its DCO trailer, and
   cryptographically verify signatures with the existing trust configuration.
   For SSH signatures without an allowed-signers file, a temporary file using the
   existing signer's public key is sufficient for local verification. GitHub's
   Verified status remains unverified until commits are pushed.
3. Run `pnpm check --base upstream/main --plan` to inspect only the fork's delta.
   Follow current repository validation rules: run explicit focused tests for the
   changed behavior and affected consumers, plus checks relevant to any conflict
   resolutions. Do not automatically run whole test projects or the full gate.
   Distinguish passed checks from environment failures or untested live behavior.
4. Report the exact CherryHQ base SHA, rewritten commit IDs, conflict outcome,
   verification results, and remaining working-tree changes. Do not push unless
   the user separately authorizes it; a rebase alone does not authorize a force push.
