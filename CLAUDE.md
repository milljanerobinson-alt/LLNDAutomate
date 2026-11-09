# Project Instructions

## Engineering Completion Reports

After EVERY task that involves code changes, the final response MUST be a copyable Engineering Completion Report — plain text, fully populated, fenced in a code block. No conversational text after the report.

The report must include at minimum:
- Reference number and title
- Status and completion date
- Executive summary (outcomes, not implementation steps)
- Scope delivered (what was built/changed, with file paths)
- Files created/modified
- Build validation result
- Any database changes (tables, migrations, RLS)
- Constraints honoured (if applicable)

## Launch-readiness tracking (mandatory)

Every development task on LLND Mate or LLND Automate must end by updating the existing
"LLND Mate — Launch Readiness" Claude artifact (do not create a duplicate tracker).

- Back up the dashboard's saved state before substantial edits.
- Update the related milestones, requirements, branding tasks, blockers and decisions with
  the branch, commit, test evidence and notes. Preserve every existing record; record
  renames and superseded values in notes.
- Keep these states separate and tick an item only with evidence for that state:
  Implemented on branch → Tests passed → CI verified → Staging verified → Deployed.
  Local or CI results never count as staging verification.
- Record new blockers and outstanding Product Owner decisions; keep the launch-video
  recording gate closed until every mandatory condition is met.
- If the dashboard cannot be reached or safely edited, do not claim it was updated:
  include an exact update checklist in the completion report instead.
- The Engineering Completion Report must state which readiness items were updated.
