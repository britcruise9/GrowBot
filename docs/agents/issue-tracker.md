# Issue tracker: GitHub fork

Issues and executable specs for this checkout live in GitHub Issues at
`jordanhindo/GrowBot`. Always pass `--repo jordanhindo/GrowBot` to `gh` because the
`origin` remote points to the read-only upstream repository.

## Conventions

- Create: `gh issue create --repo jordanhindo/GrowBot --title "..." --body-file <file>`.
- Read: `gh issue view <number> --repo jordanhindo/GrowBot --comments`.
- List: `gh issue list --repo jordanhindo/GrowBot --state open`.
- Comment: `gh issue comment <number> --repo jordanhindo/GrowBot --body "..."`.
- Apply or remove labels with `gh issue edit` and an explicit `--repo`.
- Close with `gh issue close` and an explicit `--repo`.

The fork is a staging and contribution surface, not a transfer of authority. Brit
Cruise retains final product and deployment authority in `britcruise9/GrowBot`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `jordanhindo/GrowBot`.

## When a skill says "fetch the relevant ticket"

Read the issue from `jordanhindo/GrowBot`, including its comments and labels.
