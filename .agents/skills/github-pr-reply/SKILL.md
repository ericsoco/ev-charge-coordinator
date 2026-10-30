---
name: github-pr-reply
description: Reply to open review comments on the specified Github PR (by PR number) in the ericsoco/ev-charge-coordinator repo
---

# github-pr-reply

Read the PR of the specified number in the ericsoco/ev-charge-coordinator GitHub repo.
Read any open reviews + comments, and respond locally.

If the PR number is not specified when this skill is invoked,
interact with the pull request that belongs to the current branch.

Do not write anything to GitHub -- no code pushes, no comments, no metadata changes.

## Usage

Use this skill when invoked directly by name.

## Steps

1. Use the GitHub CLI (shell commands) to view the metadata and diff:
    * gh pr view {PR_NUMBER} --json title,body,author
    * gh pr diff {PR_NUMBER}
1a. If gh auth is absent / fails, stop immediately and prompt the user to run `gh auth login`.
2. Read all open reviews + comments on the PR.
    * gh api repos/ericsoco/ev-charge-coordinator/pulls/{PR_NUMBER}/comments
    * Extract: path (file name), line (or position), body (comment content), and id / node_id (required to reply or resolve).
3a. In Plan mode, offer suggestions locally to address all PR review comments. 
    Note that comments do not exist in isolation; multiple comments may address the same topic / related concerns.
    Ensure all comments are addressed; reference each comment explicitly in your plan.
3b. In Act mode, make code changes and commit locally to address all PR review comments.
