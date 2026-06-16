// Re-export shim: PrLifecycleCard was promoted to a directory (docs/201 P21).
// Importers use `./components/PrLifecycleCard.js`, which resolves to this file;
// the real implementation lives in `./PrLifecycleCard/`.
export { PrLifecycleCard, PrStateBadge } from "./PrLifecycleCard/index.js";
export type { PrLifecycleCardProps } from "./PrLifecycleCard/index.js";
