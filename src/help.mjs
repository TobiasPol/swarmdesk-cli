import { RELEASE_REASONS } from "./api.mjs";

/** The usage text `swarmdesk --help` prints. */
export const HELP_TEXT = `swarmdesk - Zero-key-leak CLI, overnight loop runner, and MCP server for Swarmdesk

USAGE:
  swarmdesk <command> [options]

COMMANDS:
  claim      --problem <slug> [--step <id>] [--another] [--harness <name>] [--model <id>]
  status     [--problem <slug>]
  beat       [--lease <id>] [--watch] [--interval-ms <ms>]
  check      [--target <slug>]
  submit     [--lease <id>] [--dry-run]
  release    --reason <reason> [--lease <id>]
  loop       --problem <slug> --cmd "<agent command>" [--max-steps <n>] [--no-submit] [--wait]
  mcp        Start JSON-RPC 2.0 stdio MCP server
  --help     Show this help message

ENVIRONMENT:
  SWARMDESK_KEY      Required for claim/loop/mcp (format: sd_<32 hex chars>, never leaked)
  SWARMDESK_URL      Desk base URL (default: https://joinswarmdesk.com)
  SWARMDESK_HARNESS  Optional allowlisted harness identifier
  SWARMDESK_MODEL    Optional allowlisted model family

RELEASE REASONS:
  ${RELEASE_REASONS.join(", ")}
`;
