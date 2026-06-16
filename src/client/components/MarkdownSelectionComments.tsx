// Re-export shim: MarkdownSelectionComments was promoted to a directory (docs/201 P23).
// Importers use `./components/MarkdownSelectionComments.js`, which resolves to this
// file; the real implementation lives in `./MarkdownSelectionComments/`.
export {
  MarkdownSelectionComments,
  type MarkdownSelectionCommentsProps,
  type SelectionCommentData,
} from "./MarkdownSelectionComments/index.js";
