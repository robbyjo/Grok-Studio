# Profile storage and native retention

Settings → Desktop preferences exposes an aggregate desktop/Grok profile budget (default 4,096 MiB). Inspect aggregate profile storage reports file bytes by category, including native sessions, search cache, logs, media, desktop history and update binaries. Nested profile roots are counted once. Enumeration is bounded and refuses links; it does not read credential contents.

At 90% of the aggregate budget, new connections, prompts, queued work, media generation and attachment imports are refused with cleanup guidance. This is admission control, not an operating-system disk quota: a turn already running or a separate Grok process can continue writing. Desktop history, media, terminal buffers and logs retain their separate limits. Export destinations outside both profiles are excluded from the budget.

## Native session retention

1. Stop other Grok clients using the same profile. Archive the Workbench chats whose native sessions should be removed.
2. Select those sessions and a minimum age in Settings; the default is 30 days. Every session file must be older than the selected age, and every Workbench reference must be archived and idle.
3. Review the session IDs, sizes and file counts. Cancel changes nothing.
4. Confirm export/prune and select an export folder outside the desktop and Grok profiles. Workbench drains its owned native connections, verifies copies with SHA-256, rechecks the review, removes the selected session's schema-4 search-cache documents, then prunes the native folder. Upstream cloud history is not deleted.
5. To restore, select the verified export folder. Manifest paths, ownership and hashes are validated before copying. Existing native session folders are never overwritten. Restored sessions can be resumed through their archived chats after reopening them.

Only uniquely located native sessions referenced by Workbench qualify. Active, unarchived, recent, unrecognized-cache, stale-review, linked and hard-linked cases fail closed. Windows native lock handles reject an existing writer during export; folder quarantine and hash checks protect the removal step. These checks do not form a transaction across unrelated external processes. A late batch failure can leave some sessions exported/pruned or restored; verified exports remain available. Preserve exports until restoration/resume has been checked.

An unfamiliar native search-cache schema blocks pruning. Workbench does not delete arbitrary upstream cache files to reclaim space. Cache removal is limited to the selected session IDs, with vacuuming; a failed later folder operation can require normal native reindexing of the retained session.

## Acceptance

`tests/profile-storage.test.ts` covers nested accounting, eligibility/stale guards, hash/path/link failures, a real Windows writer handle and scoped search-cache eviction. `tests/ui/storage-update.spec.ts` uses an isolated native-session fixture to verify quota refusal, canceled prune, export/prune, restore and overwrite refusal.

`npx tsx scripts/retention-acceptance.ts --run --concurrency-root .test-data/live-concurrency-…` is an opt-in real acceptance. It accepts only a successful disposable eight-session test folder, artificially ages one of those owned sessions, exports/prunes/restores it and resumes it using the existing local OAuth profile. It does not export credentials or delete cloud history. Evidence is recorded separately in [VALIDATION.md](VALIDATION.md).
