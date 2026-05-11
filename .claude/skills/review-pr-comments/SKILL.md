---
name: review-pr-comments
description: Fetch PR review comments via gh CLI, classify them (valid & fix / valid & skip / invalid), fix the valid ones, reply and resolve the threads, and fix any CI failures. Invoke only when the user types /review-pr-comments — never auto-trigger.
disable-model-invocation: true
argument-hint: [pr-number]
---

# /review-pr-comments — evaluate PR feedback and fix valid issues

User-invoked only. `$ARGUMENTS` is an optional PR number; if empty, auto-detect from the current branch.

All GitHub interaction goes through `gh` CLI — never the GitHub MCP server. The MCP server is incomplete (missing endpoints for review-thread resolution, partial coverage of comment surfaces).

## 1. Identify the PR

If `$ARGUMENTS` has a number, use it.

Otherwise:

```bash
BRANCH=$(git branch --show-current)
gh pr list --head "$BRANCH" --json number,title,url --jq '.[0]'
```

If no open PR for the branch, stop and tell the user.

Capture `OWNER`, `REPO`, `PR` for the rest of the run:

```bash
gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"'
```

## 2. Fetch comments — THREE separate surfaces

GitHub exposes PR feedback in three places. Missing any one means you'll miss real comments. **Always check all three.**

### 2a. Inline review comments (line-anchored)

These are the most common — Gemini/Claude/Copilot bots, human reviewers' line-level comments.

```bash
gh api "repos/$OWNER/$REPO/pulls/$PR/comments" --paginate \
  --jq '.[] | {id, path, line, body, user: .user.login, in_reply_to_id, html_url}'
```

Fields you need: `id` (REST numeric, used for reply), `path`, `line`, `body`, `user.login`, `in_reply_to_id` (non-null = follow-up reply, ignore the duplicates).

### 2b. Inline review threads (for resolution)

To resolve a thread you need its **GraphQL node ID**. Fetch in one query and correlate by `databaseId` ↔ REST `id`:

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 1) { nodes { databaseId author { login } body } }
          }
        }
      }
    }
  }' -F owner="$OWNER" -F repo="$REPO" -F pr="$PR"
```

Build a map `databaseId → {threadId, isResolved}` so step 6 can resolve by REST comment ID.

Skip threads where `isResolved: true` — already handled.

### 2c. General PR comments (issue-level, not line-anchored)

This is where Claude-bot summaries, Gemini-bot summary, Copilot summary, and human comments-without-line-context land. The REST endpoint is `/issues/.../comments` because GitHub stores PR-level conversation as issue comments.

```bash
gh api "repos/$OWNER/$REPO/issues/$PR/comments" --paginate \
  --jq '.[] | {id, body, user: .user.login, created_at, html_url}'
```

### 2d. Review submissions (approval-level body)

When a reviewer submits "Request changes" or "Approve" they often paste a body with overall feedback. Different endpoint:

```bash
gh api "repos/$OWNER/$REPO/pulls/$PR/reviews" --paginate \
  --jq '.[] | {id, state, body, user: .user.login}'
```

### Filtering

Filter out **bot summary blobs** — purely informational, never actionable:

- `gemini-code-assist[bot]` summary comments (the long "Summary of Changes" general comment — keep the inline `[medium]`/`[high]` priority ones)
- `copilot-pull-request-reviewer[bot]` summary
- `coderabbitai[bot]` walk-through comment
- Comments whose body is just a status badge / emoji table

Keep bot comments that raise specific findings (Gemini inline, Claude bot inline, Copilot inline). Read the body, not the author — if there's a concrete code suggestion, it's actionable.

## 3. Classify each comment

For every real comment, assign one of three verdicts:

- **Valid & fix** — real bug, type error, race condition, security problem, correctness bug, data integrity issue.
- **Valid & skip** — observation is accurate but the change isn't worth it (minor stylistic preference that doesn't match project convention, premature optimization, scope creep).
- **Invalid** — the reviewer misread the code, or the proposed fix would break something.

Read the file before deciding. Don't blindly trust the reviewer; also don't reflexively dismiss bot output — Gemini/Copilot often catch real issues.

Common patterns in this codebase to watch for:

- **TypeScript strictness**: `noUncheckedIndexedAccess` is on, `T | undefined` from `arr[i]` is real. A bot warning about a missing `!` or `?? fallback` is usually valid.
- **AsyncLocalStorage usage** in `packages/server/src/telemetry/`: comments about identity propagation across async boundaries deserve careful reading.
- **SQLite query patterns** in `analytics-store.ts` / `queries.ts`: `IS` vs `=` for nullable columns, `json_each` parameter bindings — bot suggestions about these are usually correct.
- **MCP tool registration** in `mcp-handler.ts`: handlers are monkey-patched via `server.tool`; bot comments about telemetry-wrap behavior need to be checked against the wrapper, not the raw handler.
- **UUIDv7 mandatory** for all IDs (see `CLAUDE.md`). Any comment suggesting `randomUUID()` or auto-increment is **invalid**.

## 4. Present the assessment (before touching code)

```
## PR review assessment — #<PR_NUMBER>

### packages/.../file.ts:42 — <one-line gist>
Verdict: Valid & fix | Valid & skip | Invalid
Reason: <1–2 sentences>
Thread: <resolved | open>

...
```

Group by file, ordered by line. Show **all** comments — including the ones you'd skip — so the user can override your call.

Ask the user to confirm which ones to fix. Don't auto-proceed.

## 5. Fix confirmed comments

For each approved "Valid & fix":

1. **Read the affected file fully.** One-line changes in shared modules have non-obvious blast radius. Telemetry / chunker / indexer changes especially.
2. **Implement the fix.** Match existing patterns — see `CLAUDE.md` for the codebase's "Key patterns" section.
3. **Update the test if behavior changed.** A comment worth fixing is usually worth a regression test, especially for telemetry, chunking, search-result correctness, or SQL query semantics.
4. **No half-fixes.** If the fix exposes another problem (e.g. an `IS` operator suggestion reveals the prepared statement has too many parameters), fix both — don't leave the file inconsistent.

## 6. Quality gate

Run the relevant subset, in roughly increasing cost:

```bash
yarn prettier:check          # fast
yarn lint                    # fast
yarn workspace @paparats/<affected-pkg> typecheck
yarn workspace @paparats/<affected-pkg> test
```

Before pushing — full sweep:

```bash
yarn check && yarn test
```

If any quality gate fails, fix it before moving on. Never commit through a broken gate.

## 7. Reply + resolve each thread

Close the loop on GitHub. **Always reply and resolve — never silent resolution, never resolve without replying.**

### Reply to inline review comment

REST endpoint, posts a reply in the same thread as the original comment:

```bash
gh api "repos/$OWNER/$REPO/pulls/$PR/comments/$COMMENT_ID/replies" \
  -f body="Fixed in <commit-sha-short> — <one-sentence what changed>."
```

`$COMMENT_ID` is the REST numeric id of the **original** comment (not your reply).

For **Valid & skip** / **Invalid**, reply with the reason: "Not applicable because…" / "Already handled by … in `<file>:<line>`."

### Resolve the thread

Use the GraphQL `threadId` you correlated in step 2b:

```bash
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { isResolved }
    }
  }' -f threadId="$THREAD_ID"
```

### Reply to a general PR comment (step 2c)

There's no native thread / reply for issue-level comments. Either:

- Edit your follow-up commit message to reference it ("Addresses Gemini's note about X."), and skip the reply, **or**
- Post a top-level comment quoting the original: `> @<author> on <date>: …` then your response.

There's nothing to "resolve" — issue comments don't have a resolution state.

## 8. Check and fix failing CI

```bash
gh pr checks "$PR"
```

For each failing check:

```bash
# Extract run ID from the URL field of `gh pr checks --json`:
gh pr checks "$PR" --json name,state,link --jq '.[] | select(.state != "SUCCESS")'

# Then for each failing run:
RUN_ID=$(echo "$LINK" | grep -oE '[0-9]+$')
gh run view "$RUN_ID" --log-failed
```

Triage each failure:

- **PR-caused** → fix the source file or update the test to match the new behavior. Verify locally with `yarn workspace @paparats/<pkg> test`.
- **Pre-existing or flaky** → note it in the hand-off; don't silence it. If it's a known-flaky test that's been red on main too, that's an infra problem, not this PR's job.
- **Lockfile / dependency drift** → run `yarn install` locally and commit the lockfile.

## 9. Hand off

Summarise in this shape:

```
## PR #<N> review handled

Fixed (N):
- <file:line> — <what changed> (commit <sha>)
...

Replied & resolved (N + M):
- N fixes + M skip/invalid

Skipped (M):
- <file:line> — <reason>

CI:
- ✅ <check> (fixed by <commit>)
- ⚠️  <check> (pre-existing on main, not this PR)

Outstanding:
- <anything that needs the user's eyes>
```

**Never commit or push for the user.** Stage the changes; let them review and commit.
