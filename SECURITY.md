# Security

## Reporting a vulnerability

Please report security issues through GitHub's private vulnerability reporting feature when it is enabled for this repository. Do not publish tokens, credentials, or exploitable details in a public issue.

## Credential handling

Earthdata Login is optional. The local-only credential form stores a token in backend process memory and clears it when the API stops. Never put a real token in source files, screenshots, issue reports, or public deployments. The development API is bound to loopback and is not a production-hardened public service.
