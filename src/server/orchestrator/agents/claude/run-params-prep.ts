import type { PrepareRunParamsFn } from "../../agent-run-params-prep.js";

export const prepareClaudeRunParams: PrepareRunParamsFn = (params, input) => ({
  ...params,
  settingsPath: "/etc/shipit/managed-settings.json",
  autoCreatePr: input.autoCreatePrActive,
  sandbox: input.sandboxActive ?? false,
  guardDestructiveGit: input.guardDestructiveGitActive ?? false,
});
