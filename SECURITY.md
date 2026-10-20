# Security policy

## Reporting
Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this
repository (https://github.com/jasondmillwood/dish-monitor/security/advisories/new). Don't open a public issue.
We aim to reply within 7 days.

## Scope and design notes
- The web UI and API have **no authentication**. Run Dish Monitor on a trusted LAN or private VPN, or
  set `--host 127.0.0.1`. Never forward its port to the internet.
- It talks to the dish read-only, over the dish's local, unauthenticated gRPC API.
- The installer runs as your user, never as root, and writes `config.json` with mode 600.
- Supported versions: the latest release on `main`.
