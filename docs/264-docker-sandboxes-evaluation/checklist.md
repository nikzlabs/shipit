# Docker Sandboxes evaluation checklist

- [x] Record what Docker Sandboxes provides (microVM, private daemon, `sbx` CLI, mounts, ports, persistence, requirements, licensing).
- [x] Map it against ShipIt's existing isolation stack (egress tiers, `docker-proxy.ts`, trust boundaries, `container-hardening.ts`).
- [x] State where it would genuinely help and why each ShipIt mechanism blocks adoption today.
- [x] Record the falsifiable conditions that would change the recommendation.
