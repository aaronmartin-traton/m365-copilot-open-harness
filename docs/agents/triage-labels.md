# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those
roles to the actual label strings used in this repo's issue tracker. This repo
uses local markdown tracking (`.scratch/`), so labels are `Status:` lines in
each issue file — the strings below are that vocabulary.

| Skill role                  | Label in our tracker | Meaning                                        |
| --------------------------- | -------------------- | ---------------------------------------------- |
| `needs-triage`              | `needs-triage`       | Maintainer needs to evaluate this ticket       |
| `needs-info`                | `needs-info`         | Waiting on reporter for more information       |
| `ready-for-agent`           | `ready-for-agent`    | Fully specified, ready for an AFK agent        |
| `ready-for-human`           | `ready-for-human`    | Requires human implementation or live access   |
| `wontfix`                   | `wontfix`            | Will not be actioned                           |

Category labels are recorded as a `Category:` line (`bug` / `enhancement`).

When a skill mentions a label (e.g. "apply the AFK-ready label"), use the
corresponding string from the third column.