# Post-Closure Live Observations

These observations are useful real-world follow-up evidence. They are not blocking exit criteria for the completed PJSDAS Consumer-Grade Refoundation v1 package.

## OBS-CGR-001 — First natural recruiting Gmail after final repair

State: PENDING_NATURAL_EVENT

Certified baseline runtime: `58e9f7f4bd584139ffeb8c17a3ee6c8c15d94c3a`

When the first naturally arriving real recruiting Gmail message is consumed after the final repair, verify when practical:

1. transport and history accounting are exactly-once and healthy;
2. interpretation yields one correct bounded authoritative update or one concrete necessary DecisionRequest;
3. identity-free input never offers unrelated Opportunity targets;
4. conditional language such as “if already completed, ignore” does not become a completion fact;
5. conditional future-stage language does not become an interview invitation;
6. one source event does not multiply into duplicate DecisionRequests;
7. UI projection matches the authoritative result;
8. replay/redelivery remains idempotent and recoverable.

Do not send a synthetic recruiting email, replay the already-consumed historical defect message, expand permissions, create delegated grants, or mutate real recruiting state solely to satisfy this observation.

If the observation exposes a material defect, open a defect against the stable baseline and repair the earliest affected behavior. The historical CGR closure remains an honest record of the evidence available at closure.
