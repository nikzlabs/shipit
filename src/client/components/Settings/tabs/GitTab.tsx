import { SettingsTabPane } from "../SettingsTabPane.js";
import { DeclaredSettings } from "../DeclaredSettings.js";

/** One declared row: the identity's name and email, written together. */
export function GitTab() {
  return (
    <SettingsTabPane>
      <DeclaredSettings tab="git" />
    </SettingsTabPane>
  );
}
