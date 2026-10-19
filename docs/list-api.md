# LIST helper and listing harness contract

Status: implementation contract, 2026-10-19. Stage 3 of the shared command model
is implemented; the formal shared run and independent verification passed, while
author full regression, overall review, and integration remain pending. See
[cli-filesystem-training-results.md](cli-filesystem-training-results.md). This page
owns the native listing helper, typed listing result format, and test-injection
boundary. The standalone binary `cli.list-policy.v1` model profile is retired.
Listing is now Stage 3 of the unified shared command model (`cli.command-policy.v1`),
invoked as `["ls", D]` and trained via `runCliCommandTraining`. The authoritative
shared training contract is [cli-filesystem-training.md](cli-filesystem-training.md);
the simplified call contract is [cli-call-contract.md](cli-call-contract.md).

## Shared command policy integration

Under the shared command model, the model selects the lowercase command head `ls`
and outputs the parameter sequence:

```text
invocation = ["ls", D]
```

The profile, sandbox, and session are bound at the policy factory:
`createCliCommandPolicy({ profile, sandbox, session: S })`. Each call passes
`step({ goal, state, directory: D })` with
`goal = { kind: "list_directory", session: S.sessionId, target: absoluteTarget }`
and `state = { session: S.sessionId, cwdObservation: null, directoryListing: null }`.
The request has no `resources` or `directories` field. The model does not generate
arbitrary shell flags, command text, or entry contents. The harness maps
`["ls", D]` to the fixed `directory.list(session, directory)` operation.

Listing never changes the session cwd, revision, or filesystem content. If the
call fails, or if partial results are returned, the goal remains unmet or
unverified.

## Semantic call and listing result

```ts
type SemanticDirectoryListCall = {
  operation: "directory.list";
  parameters: { session: SessionRef; directory: DirectoryRef };
};
```

The sandbox requires `filesystem.read` and `process.exec`. A directory
reference must belong to the selected session and scenario. `DirectoryRef.path`
is relative and resolves against the session cwd at call time; `goal.target`
must match the bound reference's resolved target. The harness does not retarget.
The final target must not be a symlink.

The helper receives exactly one raw directory argument:

```text
process.execPath + fixed compiled helper path + D
```

It emits structured JSON:

```ts
type DirectoryListing = {
  directory: string;
  entries: Array<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "other" | "unknown";
  }>;
  coverage: "complete" | "partial";
  errors: Array<{ name: string; code: string; message: string }>;
};
```

Names are exact strings. The helper uses native `readdir` and `lstat` and
returns direct children only. It does not follow an entry link, recurse, read
content, or hide dot names. If any `lstat` fails, the name is retained with
`type: "unknown"`, the failure is retained in `errors`, and `coverage` is
`partial`. A partial result cannot satisfy a complete-list goal. Never claim
that `/bin/ls` text parsing is trained or executed.

## Public types and native harness exports

The `nnanything/cli-goal` entry exports the listing helper utilities and types:

- `collectDirectoryListing`, `DirectoryListingIo`, `DirectoryListingStats`
- `DirectoryListing`, `DirectoryListingEntry`, `DirectoryListingError`, `DirectoryListObservation`
- `validateDirectoryListing`, `directoryListHelperPath`, `runDirectoryListHelper`, `observeDirectoryListing`

Training and policy execution are unified under the shared command entrypoints:
`createCliCommandPolicy` and `runCliCommandTraining`; the shared fixture helper is
`makeCliCommandFixture`.

## Test injection

`collectDirectoryListing(directory, io?)` accepts a minimal typed dependency:

```ts
type DirectoryListingIo = {
  readdir(directory: string): Promise<readonly string[]>;
  lstat(path: string): Promise<DirectoryListingStats>;
};

type DirectoryListingStats = {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};
```

Production uses native `fs.readdir` and `fs.lstat`. A contract test may pass
real `readdir` with a failing `lstat` to exercise the actual partial-result
branch and error retention. The dependency is not a semantic-call argument
and never enters model input.

`createCliFilesystemSandbox` optionally accepts a `listingObserver` test
dependency with the same rule. Normal consumers use the native compiled helper.

