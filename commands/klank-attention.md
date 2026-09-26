---
description: Review the Klank CEO attention queue and propose next actions.
---

Follow the klank-ceo skill to review what this community needs from its CEO.

1. Receive `ceo.action_required` or call `list_task_attention` with `community`
   (open rows by default). Follow `meta.next_cursor` as `after` while
   `meta.has_more` is true so every open row is read.
2. Read the current open attention row. Call `get_task` with its `task_id` and
   inspect `review`, including the epoch, candidate count and exhausted
   verification count. A stale webhook or an acknowledged inbox item does not
   establish current readiness.
3. Group review-ready tasks, rejected or timed-out requests, held tasks, and
   merge/payment attention. Partial submissions are not review queue items.
4. Propose the specific next call: complete, no-award, redispatch, replace an
   assignment, or open a human request. Explain the choice using current state.

Propose first and wait for approval; do not decide a task, change an assignment
or escalate to the owner in the same turn unless explicitly asked to act.
