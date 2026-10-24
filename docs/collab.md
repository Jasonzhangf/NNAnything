# collab workflow

This project uses the local `collab` daemon for multi-agent coordination.
The source and build truth lives in the AppSDK repository's `collab/` directory;
the installed independent binaries are `~/.cargo/bin/collab` and
`~/.cargo/bin/collab-mcp`. From an AppSDK checkout, use
`scripts/install-global-collab.sh`; do not build a second copy from an external
Collab checkout.

There is one global user-managed daemon. Agent commands never start, stop or
restart it. `collab context` resolves the canonical project and current agent
sessionID; the stable name owns work. Tmux is only placement. A project
without a master restores a peer automatically. If a master already exists,
offer the user a choice to authorize replacing it with the current identity;
without approval, peer restoration remains available. Work content, task
ownership and worktree checks are not identity admission conditions.
If it returns `requires_identity_update.required_fields`, supply only those
real facts once with `collab context --provide '<JSON>'`. The daemon completes
the binding and lease; do not choose a worker or run another recovery command.
If the service is unavailable, preserve the identity and report that boundary.
User maintenance commands and credentials are outside the agent interface.
Existing projects migrate through `collab migrate inspect`, `plan`, `apply`,
daemon identity reconciliation through `collab context`, and `verify`;
deleting `.agent-collab`, editing JSON state, clearing mailboxes, copying
tokens, mixed runtime writes, and guessing thread identity are deprecated.

## Runtime boundary

- The daemon selects the current supported adapter from observed runtime facts.
- Registration owns one deterministic seven-day default direct-message lease;
  context restores its current binding, route and lease together. A shorter
  explicit lease cannot suppress it.
- Recovery acceptance includes actual send, receive and reply for both roles.
- Server state, journal, and mailbox are durable truth; a failed wake cannot
  roll back state or fabricate success.
- The runtime is part of the worker identity boundary, not a task preference.

## Roles

- Every registered identity is an equal `peer`; there is no inferred master
  from first registration. Codex root is not Collab master.
- Master authority is explicit user-approved project arbitration, separate
  from transport reachability. An explicitly approved takeover replaces the
  recorded holder under the current name contract. Context never auto-promotes.
- Master and peer both orchestrate goals at different levels. Each registers,
  reads, updates, rearms and closes its own goal; master does not proxy-register
  or take ownership of peer goals. Peer is not an execution worker.
- Task owner, resource holder, integration lease, and daemon operator are
  scoped capabilities, never durable identity roles.
- Report goal evidence and blockers through the assignment's report contract.
  The installed Collab Skill owns operating rules; this generated reference
  does not define a second role, scheduling or command policy.

## Operating contract

Read the current installed `collab` Skill and the current context `role_brief`.
They own goal registration, public-board assignment, task lifecycle, messaging,
finite subscriptions, worktrees, delivery and cleanup. Use the selected command's
current help for its exact arguments. Do not keep a second command catalog or
frozen workflow in this generated project reference.

The project-agnostic Canonical patrol contract lives in that Skill. Each master
patrols only its own project. Project-specific paths, commands and issue intake
details belong to the owning project; they do not replace the shared contract.

## Notifications and waits

Agent-owned subscriptions have explicit event, subject and finite lifetime.
Goal deadlines are one-shot with explicit rearm; generic periodic deadlines
have a finite occurrence count. On completion or no new task/actionable work,
close owned goal scheduling and patrols while retaining direct-message reception.
Actual enqueue, delivery and consumption remain distinct receipts.
