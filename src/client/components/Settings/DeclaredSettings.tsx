/**
 * The generated half of a settings tab (docs/308-data-driven-settings
 * plan.md → The renderer).
 *
 * Which rows a tab has, in what order and under which heading all come from the
 * catalogue, and a control receives a `SettingKey` and nothing else — it never
 * names a stored field, builds a payload or chooses a route.
 *
 * A tab is still a React component: content that is not a setting stays
 * hand-placed around this block, and `notes` carries prose belonging to a
 * section rather than to any one declaration (inventory.md P12).
 */

import { Fragment, type ReactNode } from "react";
import type {
  AnySettingDeclaration,
  SettingKey,
  SettingTab,
  SettingValueKind,
} from "../../../server/shared/settings-catalogue/index.js";
import { GENERATED_SETTINGS } from "../../stores/setting-values.js";
import { useSetting } from "./declared-setting.js";
import { DeclaredEnumCards, DeclaredToggle } from "./declared.js";
import { SETTING_COMPONENTS } from "./components/registry.js";

function GeneratedToggle({ settingKey }: { settingKey: SettingKey }) {
  const { value, set } = useSetting(settingKey);
  return <DeclaredToggle settingKey={settingKey} enabled={value === true} onToggle={set} />;
}

/**
 * A choice as a row of cards, each carrying its own declared description.
 *
 * The plan's control table also names a `<select>`, for an enum whose options
 * are many or produced by the install rather than written down. Nothing on the
 * tabs this slice generates is one — the release channel is two options with a
 * sentence each — so the select arrives with the settings that need it, in
 * slice 4.
 */
function GeneratedEnumCards({ settingKey }: { settingKey: SettingKey }) {
  const { value, set } = useSetting(settingKey);
  return (
    <DeclaredEnumCards
      settingKey={settingKey}
      value={typeof value === "string" ? value : ""}
      onChange={set}
    />
  );
}

/**
 * The control each value kind gets. A kind absent from here has no generated
 * row, which is how a slice converts the settings it supports and leaves the
 * rest hand-written rather than rendering a row that cannot save (P18).
 */
const CONTROLS: Partial<Record<SettingValueKind, (key: SettingKey) => ReactNode>> = {
  bool: (key) => <GeneratedToggle settingKey={key} />,
  enum: (key) => <GeneratedEnumCards settingKey={key} />,
};

/**
 * What one declaration renders: its component where it names one, otherwise the
 * control its value kind gets.
 *
 * One component per declaration, because every component there is names exactly
 * one. The first that is shared by two — the voice webhook's URL and token, in
 * slice 4 — is what decides how a pair renders once, and guessing that here
 * would be a branch nothing runs.
 */
function controlFor(declaration: AnySettingDeclaration): ReactNode {
  const key = declaration.key as SettingKey;
  const name = declaration.component;
  if (name === undefined) return CONTROLS[declaration.type.kind]?.(key);
  const Component = SETTING_COMPONENTS[name];
  return Component ? <Component settingKey={key} /> : null;
}

interface Group {
  section: string;
  rows: AnySettingDeclaration[];
}

/** Rows grouped by `section`, each group placed where its first declaration is. */
function groupsOf(tab: SettingTab): Group[] {
  const groups: Group[] = [];
  for (const declaration of GENERATED_SETTINGS) {
    if (declaration.tab !== tab) continue;
    const section = declaration.section ?? "";
    const group = groups.find((g) => g.section === section);
    if (group) group.rows.push(declaration);
    else groups.push({ section, rows: [declaration] });
  }
  return groups;
}

export function DeclaredSettings({
  tab,
  notes,
}: {
  tab: SettingTab;
  /** Prose a section carries, keyed by section name. */
  notes?: Readonly<Record<string, ReactNode>>;
}) {
  const groups = groupsOf(tab);
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group.section || index}>
          {index > 0 && <div className="border-t border-(--color-border-secondary)" />}
          <section className="space-y-3" aria-label={group.section || undefined}>
            {group.section && (
              <h3 className="text-sm font-medium text-(--color-text-primary)">{group.section}</h3>
            )}
            {notes?.[group.section]}
            <div className="space-y-2">
              {group.rows.map((declaration) => (
                <Fragment key={declaration.key}>
                  {controlFor(declaration)}
                </Fragment>
              ))}
            </div>
          </section>
        </Fragment>
      ))}
    </>
  );
}
