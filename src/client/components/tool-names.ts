// Tool-name helpers shared by the chat renderers (visual-elements grouping and
// message-tools rendering). Kept in their own module so the pure grouping layer
// (`visual-elements.ts`) doesn't have to import the React component file.
//
// The implementations moved to `server/shared/tool-names.ts` so the docs/244
// wire projection can ask the same "does anything render this result's content?"
// question the renderer does, from one definition — a drift there strips a body
// something draws, or ships one nothing does. Re-exported here so the client's
// existing import sites are unchanged.
export { parseMcpToolName, isPresentTool } from "../../server/shared/tool-names.js";
