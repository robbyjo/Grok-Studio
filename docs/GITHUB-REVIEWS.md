# Remote GitHub reviews

Changes → repository tools → Pull requests provides a remote diff and review editor for each listed open PR. GitHub CLI must already be authenticated. Workbench uses the CLI credential store; tokens are not copied into chat history or renderer state.

Fetch the PR's remote diff, select a file and an actual diff line on the left/right side, and add inline drafts. An omitted/truncated patch cannot accept inline comments. Local comments stay local; copying one into a remote draft requires validation against that PR's current diff. Enter an optional summary and choose Comment, Approve or Request changes (the latter requires a summary).

Review the complete payload, then explicitly confirm submission. The preview is bound to the PR's head and diff revision. A changed head/base/diff invalidates it. Publication uses GitHub's [pull request reviews API](https://docs.github.com/en/rest/pulls/reviews), including the reviewed commit and line/side positions. GitHub permissions and self-review rules still apply. A remote change after the final read can make a commit-bound review outdated; the API does not offer an atomic compare-and-swap against the PR head.

Workbench retains a bounded local submission ledger. A known successful review is returned rather than duplicated. If a response is lost or the app crashes during submission, the next attempt searches GitHub for the unique review marker. A found review is recovered. If the outcome cannot be determined, Workbench refuses an automatic resend; inspect the PR before preparing a new explicit review.

The live acceptance script `npx tsx scripts/github-pr-acceptance.ts --run --review` creates only its disposable acceptance branch/draft PR, tests stale-head rejection, publishes a comment review with a real inline comment, and verifies the remote result. The disposable PR is closed without merging and its branch deleted. Approve/request-changes are covered with fixtures because the authenticated account owns this acceptance PR and cannot self-approve/request changes. See [VALIDATION.md](VALIDATION.md).
