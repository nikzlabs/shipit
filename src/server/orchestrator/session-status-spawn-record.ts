/**
 * docs/303 req 21 — the value of `advanced.sessionStatusCard` each session's
 * resident agent was spawned with.
 *
 * The tool list and the prompt are fixed at spawn, and a spawn variable never
 * reaches a process that outlives its turn. Recording it where the value is
 * decided — `buildAgentRunParams`, which every spawning path goes through and
 * no reuse path does — is what makes the record cover dispatched turns and
 * failover respawns, not only the interactive path. A session with no record
 * (an adopted process, an orchestrator restart) is left alone: the next spawn
 * writes one.
 */
const spawnedWith = new Map<string, boolean>();

export function recordStatusCardSpawn(sessionId: string, sessionStatusCard: boolean): void {
  spawnedWith.set(sessionId, sessionStatusCard);
}

export function statusCardSpawnValue(sessionId: string): boolean | undefined {
  return spawnedWith.get(sessionId);
}

export function forgetStatusCardSpawn(sessionId: string): void {
  spawnedWith.delete(sessionId);
}
