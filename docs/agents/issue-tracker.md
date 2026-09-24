# Issue tracker: GitHub

Issues and specs for this repo live in the `itissid/whiteboard` fork's GitHub Issues. Use the `gh` CLI with `--repo itissid/whiteboard` for all operations so commands do not target the upstream remote.

## Conventions

- **Create an issue**: `gh issue create --repo itissid/whiteboard --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view --repo itissid/whiteboard <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo itissid/whiteboard --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment --repo itissid/whiteboard <number> --body "..."`
- **Apply / remove labels**: `gh issue edit --repo itissid/whiteboard <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close --repo itissid/whiteboard <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view --repo itissid/whiteboard <number> --comments` and `gh pr diff --repo itissid/whiteboard <number>` for the diff.
- **List external PRs for triage**: `gh pr list --repo itissid/whiteboard --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: use `gh pr comment`, `gh pr edit`, or `gh pr close` with `--repo itissid/whiteboard`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view --repo itissid/whiteboard 42` and fall back to `gh issue view --repo itissid/whiteboard 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `itissid/whiteboard`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view --repo itissid/whiteboard <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Create it with `gh issue create --repo itissid/whiteboard --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/itissid/whiteboard/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/itissid/whiteboard/issues/<n> --jq .id`, not the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit --repo itissid/whiteboard <n> --add-assignee @me`, the session's first write.
- **Resolve**: comment on and close the issue, then append a context pointer (gist + link) to the map's Decisions-so-far.
