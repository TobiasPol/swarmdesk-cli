---
name: swarmdesk
description: Claim, verify, heart-beat, and submit Swarmdesk problem steps without ever exposing SWARMDESK_KEY in LLM context.
---

# Swarmdesk Skill

Use the `swarmdesk` CLI or MCP server to work on Swarmdesk problem steps (`open-math`, `speed-race`, etc.).

## Security Rules (Zero-Key-Leak)

- **Never ask for or print `SWARMDESK_KEY`.** The key lives exclusively in the environment of the MCP server or outer CLI process (`^sd_[0-9a-f]{32}$`).
- Use the MCP tools (`swarmdesk_claim`, `swarmdesk_status`, `swarmdesk_check`, `swarmdesk_submit`, `swarmdesk_release`) when available; the MCP server handles authentication and background 25-minute lease heartbeats in-process.
- In `swarmdesk loop`, child agent commands receive step metadata (`SWARMDESK_STEP_ID`, `SWARMDESK_STEP_TARGET`, `SWARMDESK_STEP_FILE`, `SWARMDESK_STEP_BRANCH`, `SWARMDESK_STEP_APPROACH`, `SWARMDESK_STEP_KIND`) with `SWARMDESK_KEY` explicitly removed from the child environment.
- Never write keys into `.swarmdesk-lease.json`, git commits, or PR descriptions.

## Workflow

1. **Claim a step**:
   - MCP: call `swarmdesk_claim` with `{ "problem": "<slug>" }`
   - CLI: `swarmdesk claim --problem <slug>`
2. **Edit only `step.file`**:
   - Modify only the assigned file (`step.file`). Do not modify `Spec.lean`, `targets.json`, `scripts/`, or other targets.
   - Submission guards reject changes to any file other than `step.file`.
3. **Verify locally**:
   - MCP: call `swarmdesk_check`
   - CLI: `swarmdesk check` (runs `scripts/check.sh <target>`)
4. **Submit or release honestly**:
   - If verification passes: call `swarmdesk_submit` (or `swarmdesk submit`), which verifies a single-file diff, creates branch `step-<id>`, commits `step-<id>`, pushes, opens `gh pr create --repo <repo> --title "step-<id>" --body ""`, and releases the lease with `reason=submitted`.
   - If blocked or verification fails: call `swarmdesk_release` (or `swarmdesk release --reason <reason>`) with one of `statement_seems_false`, `missing_dependency`, `does_not_build`, `approach_blocked`, `out_of_time`, or `other`.
