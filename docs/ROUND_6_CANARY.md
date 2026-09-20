# PJSDAS Round 6 — Owner Canary

Status: **IN PROGRESS — PRE-MIGRATION**

Baseline release: `v1.1.0-rc.1`

Current state:
- legacy Web origin remains active;
- workspace authority remains `google-drive`;
- audience mode remains `legacy`;
- browser auto-sync is frozen for migration inspection;
- owner transactional workspace has not been created;
- owner access grant has not been activated;
- production backend prerequisites for migration have been configured.

Canary sequence:
1. redeploy the production backend;
2. inspect Local, Drive, and connected fingerprints;
3. fail closed on divergent non-empty state;
4. retain recovery material;
5. bootstrap and verify the owner transactional workspace;
6. create owner access;
7. switch Web and backend authority together;
8. verify owner canary before controlled launch.

No authority, audience, or domain cutover is performed by this document.
