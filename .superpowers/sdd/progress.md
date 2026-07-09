# AutoViral MCN Redesign — SDD Progress Ledger

Worktree: `C:\Users\顾庆冲\autoviral\.claude\worktrees\autoviral-mcn-redesign`
Branch: `worktree-autoviral-mcn-redesign`
Base commit: `d1e0e00`

## Global Constraints (from fix-spec.md + CLAUDE.md)

- ESM imports must use `.js` extension; no `require`.
- Work status enum: `draft | researching | planning | assetting | assembling | reviewing | published | failed`.
- All structured data in SQLite via `src/db/<entity>-repo.ts`; services never write SQL directly.
- Use `resolveClaudeCommand` from `../ws-bridge.js` for Claude CLI calls.
- Use `getDb` from `src/db/connection.js`; use `toJson`/`fromJson` from `src/db/json.js`.
- Use `randomUUID` from `node:crypto` for IDs.
- Subagents must use Opus model per CLAUDE.md rules.
- Frontend navigation tabs accumulate; never delete old tabs.

## Phase 1 Tasks

- [x] Task 1: Add `better-sqlite3` dependency (commits d1e0e00..2e8dbbb, review clean)
- [x] Task 2: Database connection module (commits 2e8dbbb..c0be3e6, review clean)
- [x] Task 3: Migration runner and initial schema (commits c0be3e6..c12f343, review clean)
- [x] Task 4: Work repository (commits c12f343..2261f63, review clean; fix review clean)
- [x] Task 5: Topic and trend snapshot repositories (commits 2261f63..f7e4509, review clean)
- [x] Task 6: Article and script repositories (commits f7e4509..35c3a8c, review clean)
- [x] Task 7: Refactor `work-store.ts` to delegate to repositories (commit 27ccd6d, review approved; minor: unused imports in `src/db/migrate-legacy.ts`)
- [x] Task 8: Run migrations and legacy migration on server startup (commit b7e495c, review clean)
- [x] Task 9: Trend research service (commits b7e495c..a5e6976..861cd24, review approved with known issues)
  - Known issue: `POST /api/topics/:id/convert` sequential DB writes are not atomic (pre-existing, does not block task; flag for final review)
  - Known issue: `createWork` disk side effects in API tests are not cleaned up (minor)
- [x] Task 9.5: Scheduled trend collection (commit f479ae4, review clean)
- [x] Task 10: Frontend topic center page (commit 881a19d, review clean; minor: unused i18n imports in Topics.svelte, brief-copied)
- [x] Task 11: API endpoint tests for topics (commit 289585a, review clean)
- [x] Task 12: Self-review and Phase 1 handoff

## Phase 2 Tasks (pending Phase 1)

- [ ] Task 1: Extend config and DB types/migrations
- [ ] Task 2: Avatar repository
- [ ] Task 3: Digital human job repository
- [ ] Task 4: Asset library metadata repository
- [ ] Task 5: Chanjing API client
- [ ] Task 6: Bailian fallback client
- [ ] Task 7: Digital human orchestration service
- [ ] Task 8: Asset library service
- [ ] Task 9: Digital human and asset library API routes
- [ ] Task 10: Frontend API wrappers and i18n
- [ ] Task 11: Digital humans page
- [ ] Task 12: Assets page
- [ ] Task 13: Tests and Phase 2 handoff

## Completed

_None yet._
