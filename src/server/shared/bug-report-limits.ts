// GitHub refuses an issue title above 256 characters and an issue body above 65,536. The body
// limit leaves room for the footer (docs/164-user-bug-filing/plan.md, "Length limits").
export const MAX_BUG_REPORT_TITLE_LENGTH = 256;
export const MAX_BUG_REPORT_BODY_LENGTH = 60_000;
