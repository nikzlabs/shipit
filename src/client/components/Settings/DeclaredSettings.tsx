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
import { DeclaredToggle } from "./declared.js";

function GeneratedToggle({ settingKey }: { settingKey: SettingKey }) {
  const { value, set } = useSetting(settingKey);
  return <DeclaredToggle settingKey={settingKey} enabled={value === true} onToggle={set} />;
}

/**
 * The control each value kind gets. A kind absent from here has no generated
 * row, which is how a slice converts the settings it supports and leaves the
 * rest hand-written rather than rendering a row that cannot save (P18).
 */
const CONTROLS: Partial<Record<SettingValueKind, (key: SettingKey) => ReactNode>> = {
  bool: (key) => <GeneratedToggle settingKey={key} />,
};

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
                  {CONTROLS[declaration.type.kind]?.(declaration.key as SettingKey)}
                </Fragment>
              ))}
            </div>
          </section>
        </Fragment>
      ))}
    </>
  );
}
