# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → [Report a vulnerability](https://github.com/telcoray/LighterDeck/security/advisories/new)**.
Only the maintainers see the report until a fix is out. Please don't open a public issue for it, and never
include real keys, not even test ones.

## How LighterDeck handles API keys

On a public instance (such as lighterdeck.xyz) the visitor's Lighter API key stays in their browser:
orders are signed there with Lighter's official signer ([lighter-go](https://github.com/elliottech/lighter-go),
compiled to WebAssembly, see `frontend/signer/`) and sent straight to Lighter. The server never receives it.
The optional automation key is kept on the server encrypted with AES-256-GCM (`backend/users.py`).

The full explanation for users is on the Security page (`frontend/security.html`, served at `/security`).
