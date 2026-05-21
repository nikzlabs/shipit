/**
 * Describes a project template available from the orchestrator's template
 * catalog. Used by NewRepoDialog and related stores to render the template
 * picker when creating a new repo from a built-in starter.
 */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: "frontend" | "fullstack" | "backend" | "utility";
  icon: string;
}
