import type { PrepareRunParamsFn } from "../../agent-run-params-prep.js";
import { CLAUDE_MANAGED_SETTINGS_PATH } from "../../../shared/claude-managed-settings.js";

export const prepareClaudeRunParams: PrepareRunParamsFn = (params, input) => ({
  ...params,
  settingsPath: CLAUDE_MANAGED_SETTINGS_PATH,
  autoCreatePr: input.autoCreatePrActive,
  sandbox: input.sandboxActive ?? false,
  guardDestructiveGit: input.guardDestructiveGitActive ?? false,
});
