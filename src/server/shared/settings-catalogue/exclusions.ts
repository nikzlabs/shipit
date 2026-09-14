import type { SettingScope, SettingTab } from "./types.js";

/**
 * Things the two dialogs show that are **not settings**
 * (docs/299-agent-settings-access req 5, plan.md → Not everything in a dialog
 * is a setting). A value nobody can edit is not a setting the agent is refused —
 * it was never a setting, so it is named here with the reason rather than
 * declared with a refusal.
 */

export type ExclusionReason =
  /** Computed from other state; editable by nobody. */
  | "derived-status"
  /** Words, not a control — copy that explains where the setting actually is. */
  | "explanatory-copy"
  /** A button that runs something rather than storing a value. */
  | "action"
  /** A control of a dialog req 5 does not name. */
  | "other-dialog";

export interface SettingExclusion {
  /** Stable id, so a coverage walk can name what it matched. */
  readonly id: string;
  readonly tab: SettingTab;
  readonly scope: SettingScope;
  /** What the dialog calls it, so a reader can find it on screen. */
  readonly label: string;
  readonly reason: ExclusionReason;
  /** Why it is not a setting. This sentence is what review reads. */
  readonly why: string;
  /**
   * The accessible names the coverage walk should accept for this entry, when
   * the controls are not named by the label itself — a group of buttons, or a
   * label written for a reader rather than for a control. Defaults to the label.
   */
  readonly controls?: readonly string[];
  /**
   * Every control on the tab is this exclusion. Only for a tab that holds no
   * setting at all, which today is Skills.
   */
  readonly wholeTab?: true;
}

export const SETTING_EXCLUSIONS: readonly SettingExclusion[] = [
  {
    id: "services.installedHarnesses",
    tab: "services",
    scope: "global",
    label: "Installed harnesses",
    reason: "derived-status",
    why: "A statement, not a control: the harnesses come from the session image "
      + "(`Settings/ServicesPanel.tsx:418`).",
  },
  {
    id: "services.supportedModels",
    tab: "services",
    scope: "global",
    label: "Supported models",
    reason: "derived-status",
    why: "Opens a read-only list of what each service offers; nothing about it is stored.",
    // Twice over: the panel heading's reference, and the count on each card.
    controls: ["Supported models"],
  },
  {
    id: "services.quotaReadout",
    tab: "services",
    scope: "global",
    label: "Reported quota on a credential row",
    reason: "derived-status",
    why: "The provider's own reported usage. The cutoffs beside it are the settings. Its one "
      + "control re-reads the provider's figure and stores nothing.",
    controls: ["Refresh subscription usage"],
  },
  {
    id: "roles.reviewerParams",
    tab: "roles",
    scope: "global",
    label: "What the reviewer runs on",
    reason: "explanatory-copy",
    why: "The reserved `reviewer` role renders no control, only a paragraph pointing at the "
      + "two reviewer slots (`Settings/roles/RoleEditor.tsx:245`). The slots are the settings.",
  },
  {
    id: "roles.editorDismiss",
    tab: "roles",
    scope: "global",
    label: "Cancel · Close (the role editor)",
    reason: "action",
    why: "Both close the editor and discard the draft. Save is the write, and it belongs to the "
      + "roles collection.",
    controls: ["Cancel", "Close"],
  },
  {
    id: "roles.unavailableReason",
    tab: "roles",
    scope: "global",
    label: "A role's unavailable reason",
    reason: "derived-status",
    why: "Computed from the credentials a role resolves against (`RoleUnavailableReason`). A "
      + "read of the role carries it as the reason the role is not running.",
  },
  {
    id: "integrations.mcpServerState",
    tab: "integrations",
    scope: "global",
    label: "An MCP server's connected state",
    reason: "derived-status",
    why: "`McpServerState` is the result of loading the server, not a stored choice. A read of "
      + "the server carries it beside `enabled`.",
  },
  {
    id: "integrations.mcpTest",
    tab: "integrations",
    scope: "global",
    label: "Test (an MCP server)",
    reason: "action",
    why: "Runs a connection attempt and reports its tools; stores nothing.",
    controls: ["Test", "Testing…"],
  },
  {
    id: "integrations.mcpFormCancel",
    tab: "integrations",
    scope: "global",
    label: "Cancel (the MCP server form)",
    reason: "action",
    why: "Closes the form and discards the draft. Save is the write, and it belongs to the MCP "
      + "servers collection.",
    controls: ["Cancel"],
  },
  {
    id: "integrations.linearTeams",
    tab: "integrations",
    scope: "global",
    label: "Linear teams the credential can reach",
    reason: "derived-status",
    why: "A lookup against the stored token. Which team a repository's Issues tab shows is that "
      + "repository's own declaration, not a setting here (`SettingsTrackers.tsx:13`).",
  },
  {
    id: "instructions.agentInstructionsText",
    tab: "instructions",
    scope: "global",
    label: "ShipIt Agent Instructions (the text)",
    reason: "explanatory-copy",
    why: "Displayed content, shipped with ShipIt. The setting beside it is the toggle that "
      + "enables it, and its one control only shows and hides the text.",
    controls: ["View instructions", "Hide instructions"],
  },
  {
    id: "instructions.commit",
    tab: "instructions",
    scope: "global",
    label: "Save · Cancel",
    reason: "action",
    why: "Save commits both instruction boxes in one write, so it belongs to neither "
      + "declaration; Cancel closes the dialog. The two textareas above are the settings.",
    controls: ["Save", "Cancel"],
  },
  {
    id: "skills.tab",
    tab: "skills",
    scope: "global",
    label: "Skills",
    reason: "action",
    why: "Discover-only — no installed list and no uninstall. Installing is repo-targeted and "
      + "opens a pull request in a session of its own (`SkillsTab.tsx:1`).",
    wholeTab: true,
  },
  {
    id: "keyboard.fixedKeys",
    tab: "keyboard",
    scope: "browser",
    label: "Editor keys like Enter and Esc are fixed",
    reason: "explanatory-copy",
    why: "Rows that state a binding ShipIt does not let anyone change; they render a hint instead "
      + "of a control.",
  },
  {
    id: "voice.cleanupModel",
    tab: "voice",
    scope: "global",
    label: "What cleans a dictation",
    reason: "explanatory-copy",
    why: "Names the Background work model and links to it. The setting is that model pin, on the "
      + "Services tab.",
    controls: ["Background work"],
  },
  {
    id: "voice.keyboardTabLink",
    tab: "voice",
    scope: "global",
    label: "Mic hotkeys are configured in Keyboard settings",
    reason: "explanatory-copy",
    why: "A sentence pointing at the Keyboard tab, whose link moves the dialog there. The "
      + "shortcuts themselves are that tab's settings.",
    controls: ["Keyboard"],
  },
  {
    id: "voice.adoptVoiceKey",
    tab: "voice",
    scope: "global",
    label: "Use your key for cleanup too?",
    reason: "action",
    why: "An offer to copy a stored speech key into the model providers, which runs a server-side "
      + "copy rather than storing a value of its own. Declining only hides the offer.",
    controls: ["Add it as a model provider", "Not now"],
  },
  {
    id: "voice.testPlayback",
    tab: "voice",
    scope: "global",
    label: "Test playback",
    reason: "action",
    why: "Speaks a test sentence with the current key; stores nothing.",
  },
  {
    id: "network.enforcementState",
    tab: "network",
    scope: "global",
    label: "Contained — NOT enforced on this deployment",
    reason: "derived-status",
    why: "Computed from whether this deployment can run the egress sidecar. A read of the "
      + "containment setting carries it as the reason the setting is not in effect.",
  },
  {
    id: "network.derivedHosts",
    tab: "network",
    scope: "global",
    label: "Also allowed — from your deployment & connected MCP servers",
    reason: "derived-status",
    why: "Derived from the deployment's own configuration and the connected MCP servers; the "
      + "list is read-only in the dialog too.",
  },
  {
    id: "network.grantOutcome",
    tab: "network",
    scope: "global",
    label: "What adding a host actually did",
    reason: "derived-status",
    why: "Reports where a just-added host took effect and where it did not. Its one control "
      + "dismisses the report; the host itself is already in the list above.",
    controls: ["Dismiss"],
  },
  {
    id: "network.sessionHosts",
    tab: "network",
    scope: "global",
    label: "A single session's egress hosts",
    reason: "other-dialog",
    why: "The Network tab deliberately loads the global list only "
      + "(`SettingsEgress.tsx:218`); a session host comes from that session's egress prompt card "
      + "and its own session dialog, which req 5 does not name.",
  },
  {
    id: "advanced.updateStatus",
    tab: "advanced",
    scope: "global",
    label: "Current version and update availability",
    reason: "derived-status",
    why: "Read from the running image and the remote; the release channel beside it is the "
      + "setting.",
  },
  {
    id: "advanced.updateActions",
    tab: "advanced",
    scope: "global",
    label: "Check for Updates · Update Now · Just Restart",
    reason: "action",
    why: "Each runs something. None of the three stores a value.",
    controls: ["Check for Updates", "Update Now", "Just Restart"],
  },
  {
    id: "advanced.resetEverything",
    tab: "advanced",
    scope: "global",
    label: "Reset Everything",
    reason: "action",
    why: "Deletes sessions, history and settings. An action, and a destructive one.",
  },
  {
    id: "project-deployments.hostingLinks",
    tab: "project-deployments",
    scope: "project",
    label: "Connect your repo · How it works",
    reason: "explanatory-copy",
    why: "The Deployments tab holds one toggle plus copy and outbound links to hosting platforms "
      + "(`ProjectSettings.tsx:76`–`120`). Deployment configuration and hosting tokens live on the "
      + "platform, not in ShipIt.",
  },
  {
    id: "project-secrets.declaredNames",
    tab: "project-secrets",
    scope: "project",
    label: "Secrets a service declares it needs",
    reason: "derived-status",
    why: "Read from what the repository's own services and activated plugins say they need. "
      + "Which names are set is the setting; the declaration belongs to the repository.",
  },
];
