# Checklist — Services drawer inside Preview

- [x] Extract `ServiceLogViewer` into its own component
- [x] Build `PreviewServicesDrawer` (collapse + vertical resize, persisted)
- [x] Reuse `ServiceList` for the expanded list view; port chip pivots preview
- [x] Wire drawer under `PreviewFrame` in a flex column in `App.tsx`
- [x] Remove the standalone Services tab button + render branch
- [x] Coerce persisted `rightTab === "services"` → preview/files
- [x] Delete the old `ServicesPanel.tsx`
- [x] Component tests for collapse/expand, log drill-in, port pivot, persistence
- [ ] Manual check in the dogfood preview (drag-resize feel, log streaming)
