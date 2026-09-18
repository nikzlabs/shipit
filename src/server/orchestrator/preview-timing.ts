interface PortMark {
  at: number;
  service: string;
  reported: boolean;
}

// Track ports separately: install-gated services can start in a later batch.
const marks = new Map<string, Map<number, PortMark>>();

export interface StartedService {
  name: string;
  port?: number;
}

// Mark immediately after compose up, before containment or network setup.
export function markStackUp(sessionId: string, services: StartedService[]): void {
  let byPort = marks.get(sessionId);
  if (!byPort) {
    byPort = new Map();
    marks.set(sessionId, byPort);
  }
  const at = Date.now();
  for (const svc of services) {
    if (svc.port === undefined) continue;
    byPort.set(svc.port, { at, service: svc.name, reported: false });
  }
}

export function markPreviewReachable(sessionId: string, port: number): void {
  const mark = marks.get(sessionId)?.get(port);
  if (!mark || mark.reported) return;
  mark.reported = true;
  console.log(
    `[timing] preview.first-connect for ${sessionId} port=${port} ` +
      `afterComposeUp=${Date.now() - mark.at}ms service=${mark.service}`,
  );
}

export function forgetStackUp(sessionId: string): void {
  marks.delete(sessionId);
}
