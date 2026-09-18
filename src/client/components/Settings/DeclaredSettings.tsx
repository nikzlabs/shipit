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
import {
  placedOnTab,
  type AnySettingDeclaration,
  type SettingKey,
  type SettingTab,
} from "../../../server/shared/settings-catalogue/index.js";
import { GENERATED_SETTINGS } from "../../stores/setting-values.js";
import { CONTROLS } from "./declared-controls.js";
import { DeclaredCommit } from "./DeclaredCommit.js";
import { SETTING_COMPONENTS } from "./components/registry.js";

/**
 * What one declaration renders: its component where it names one, otherwise the
 * control its value kind gets.
 *
 * **A component is rendered once, however many declarations name it** — at the
 * first of them, so its place is still a declaration's place (req 11). The voice
 * webhook decided that: one URL and one token are one credential saved by one
 * button, so a second render would be a second Save writing the same request.
 * The same rule puts the TTS provider, voice and speed in one control, which is
 * what lets changing the provider repair the other two (inventory.md P3, P7).
 *
 * A component that owns several declarations names them itself rather than
 * reading them off a list, because it has to know which is which: a positional
 * `[provider, voice, speed]` would be decided by catalogue order in another
 * file. So the prop stays the one key a single-setting component needs, and a
 * component that does not need it takes no props at all.
 */
export function controlFor(declaration: AnySettingDeclaration): ReactNode {
  const key = declaration.key as SettingKey;
  const name = declaration.component;
  if (name === undefined) return CONTROLS[declaration.type.kind]?.render(key);
  const Component = SETTING_COMPONENTS[name];
  return Component ? <Component settingKey={key} /> : null;
}

interface Group {
  section: string;
  rows: AnySettingDeclaration[];
}

/**
 * Whether this tab has a row the tab's Save owns. A row naming a component is
 * excluded whatever its kind, which is the exclusion `useTabDrafts` makes too.
 */
function needsCommit(tab: SettingTab): boolean {
  return GENERATED_SETTINGS.some(
    (declaration) =>
      declaration.tab === tab
      && declaration.component === undefined
      && CONTROLS[declaration.type.kind]?.commitsOnButton === true,
  );
}

/**
 * Rows grouped by `section`, each group placed where its first declaration is —
 * with a shared component appearing only at the first declaration that names it.
 *
 * "First" is `placedOnTab`'s order, not the registry's: a row may state an
 * `order`, and a section moves with the first of its rows.
 */
function groupsOf(tab: SettingTab): Group[] {
  const groups: Group[] = [];
  const rendered = new Set<string>();
  for (const declaration of placedOnTab(tab, GENERATED_SETTINGS)) {
    if (declaration.component !== undefined) {
      if (rendered.has(declaration.component)) continue;
      rendered.add(declaration.component);
    }
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
  rowNotes,
}: {
  tab: SettingTab;
  /** Prose a section carries, keyed by section name. */
  notes?: Readonly<Record<string, ReactNode>>;
  /**
   * Derived status belonging to one row, keyed by setting key and rendered
   * beneath that row's control (inventory.md P12).
   *
   * A section `note` renders above its rows, which is the wrong place for a line
   * that reports on the row above it — the Voice tab has two, the key a provider
   * still needs and whether transcript cleanup can run at all. Slice 3 found the
   * same limit with one user and left it; this is the second and third.
   */
  rowNotes?: Readonly<Record<string, ReactNode>>;
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
                  {rowNotes?.[declaration.key]}
                </Fragment>
              ))}
            </div>
          </section>
        </Fragment>
      ))}
      {needsCommit(tab) && (
        /*
          The offsets are NEGATIVE so the bar bleeds through the tab's padding
          and reads as the pinned footer it replaces: a sticky `bottom-0` stops
          at the content box, leaving that padding of content showing under it.
        */
        <div className="sticky -bottom-4 -mx-5 -mb-4 flex items-center justify-end border-t border-(--color-border-secondary) bg-(--color-bg-elevated) px-5 py-3">
          <DeclaredCommit tab={tab} />
        </div>
      )}
    </>
  );
}
