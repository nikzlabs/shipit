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
} from "../../../server/shared/settings-catalogue/index.js";
import { GENERATED_SETTINGS } from "../../stores/setting-values.js";
import { CONTROLS } from "./declared-controls.js";
import { SETTING_COMPONENTS } from "./components/registry.js";

/**
 * What one declaration renders: its component where it names one, otherwise the
 * control its value kind gets.
 *
 * One component per declaration, because every component there is names exactly
 * one. The first that is shared by two — the voice webhook's URL and token, in
 * slice 4 — is what decides how a pair renders once, and guessing that here
 * would be a branch nothing runs.
 */
export function controlFor(declaration: AnySettingDeclaration): ReactNode {
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
