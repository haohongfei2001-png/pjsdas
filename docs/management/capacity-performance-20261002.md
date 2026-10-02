# First-capacity interaction investigation, 2026-10-02

## Retained failure

Exact main `80d77406` Matrix run `37071155398` completed 204 core and 134 dense Firefox/WebKit tests, then failed the first performance fixture's zero-long-task assertion: one 52 ms task exceeded the unchanged 50 ms limit on the first capacity edit with 3,940 history rows. All p95 command latency budgets passed; the other three performance tests passed. Artifact `11255242543` retains that failure. The earlier PR-head run `37067540395` passed; that pass did not prove a root cause for the later main failure.

## Measured source hot path

A synthetic Node CPU profile of the exact dense fixture showed `actionableDecision` dominating the Today selector. Each of 358 requests rebuilt lookup Sets over 384 opportunities and 599 schedule nodes before a cheap missing-target rejection. Warm selector samples were approximately 20–22 ms; action ranking alone was approximately 0.3 ms.

The change constructs those identical indexes lazily, and shares them only inside one synchronous `partitionDecisions` call. Early rejection predicates, source/target confidence, lifecycle and resolution rules are unchanged. No cache survives a call, revision or account. Single-request evaluation still builds its own indexes when needed.

Deterministic tests verify zero workspace scans for the 358 immediate rejections and one scan per batch for 358 eligible requests. A frozen pre-change predicate baseline checks equivalent output across active/inactive/unknown targets, source age/revision and statement modes. Existing functional tests remain required.

Post-change Node selector samples were approximately 4.4–7.3 ms warm. These are source-only measurements, not browser or production acceptance, and do not prove this allocation path was the sole cause of the isolated 52 ms browser task.

## Browser evidence required

The first performance fixture now retains all stage timings and command intervals, instead of discarding everything except aggregate durable-outbox samples. Runtime metrics add only numeric start/end timing values. All thresholds, sample counts, fixtures, long-task assertions and browser checks remain unchanged. Local Chromium could not run because the execution sandbox refused socket creation; hosted exact-head and exact-main browser/performance checks must establish the outcome before closure.
