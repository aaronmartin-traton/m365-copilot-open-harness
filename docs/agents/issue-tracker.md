# Issue Tracker

Issues and specs for this repo live as markdown files in `.scratch/`. This is
the **local markdown** tracker (no external service).

## Config

- **Tracker:** local markdown files under `.scratch/`
- **Category labels:** `bug` / `enhancement`
- **State labels:** `needs-triage`, `needs-info`, `ready-for-agent`,
  `ready-for-human`, `wontfix` (see `triage-labels.md`)
- **External PRs:** not a request surface (no backlog intake from PRs)

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never
  a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue
  file (see `triage-labels.md` for the role strings)
- A `Blocked by: NN, NN` line near the top lists upstream tickets by number.
  A ticket is unblocked when every ticket it lists is `resolved`
- Comments and conversation history append to the bottom of the file under a
  `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/`. Create the directory when
it does not exist.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or
the issue number directly.
