import { SettingsTabPane } from "../SettingsTabPane.js";
import { DeclaredCommit } from "../DeclaredCommit.js";
import { DeclaredSettings } from "../DeclaredSettings.js";

/**
 * One declared row — the identity's name and email, which are one setting
 * because they are written together — and the Save that commits it.
 */
export function GitTab() {
  return (
    <SettingsTabPane footer={<DeclaredCommit tab="git" />}>
      <DeclaredSettings tab="git" />
    </SettingsTabPane>
  );
}
