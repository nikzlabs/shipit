/**
 * Which ShipIt instance owns a Docker resource. Two instances on one daemon each hold a session
 * store that knows nothing of the other's sessions, so every "not in my store ⇒ orphan" sweep
 * and every stop script selects by this label (planning#584, docs/091).
 *
 * The filter is positive: a resource with NO stack label is foreign, not ours. Ownership fails
 * closed — a dangling volume may be another instance's stopped database. An instance that runs
 * with no DOCKER_STACK applies no filter, and so keeps the host-wide sweeps it always had.
 */
export const STACK_LABEL = "shipit-stack";

export function stackLabel(stackName: string | undefined): Record<string, string> {
  return stackName ? { [STACK_LABEL]: stackName } : {};
}

export function stackLabelFilters(stackName: string | undefined): string[] {
  return stackName ? [`${STACK_LABEL}=${stackName}`] : [];
}
