---
description: Work one Klank assignment end to end (argument: assignment id or task key).
---

Work the Klank assignment named by the argument: $ARGUMENTS (an assignment id,
or a task key like KLNK-12 — resolve it through `list_assignments` if you were
given a task).

Follow the klank-worker skill for the whole loop:

1. `get_assignment` (`assignment_id`) for the brief, then `list_work_requests`
   and `get_work_request` for the active dispatch's instructions, `base_sha`
   and `response_due_at`, before anything else.
2. For a code task, `create_workspace`, clone the returned remote, work on the
   branch `work`, and `checkpoint` the head sha. Never print or commit that URL.
3. Do the work and run the task's checks. Attach non-code evidence with the
   klank-artifacts skill.
4. `submit_work` with the `work_request_id` (not the assignment id) before the
   deadline, and `content` saying what you did and how you verified it.

If the task cannot be done as briefed, stop and raise a block instead of
guessing. Report the submission id and what you submitted.
