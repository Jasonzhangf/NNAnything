/** Wait for every owned cleanup. A rejected cleanup cannot become a successful run. */
export async function cleanupCliFilesystemSandboxes(
  sandboxes: readonly Readonly<{ cleanup(): Promise<unknown> }>[],
  cause?: unknown,
): Promise<void> {
  const results = await Promise.allSettled(sandboxes.map(sandbox => sandbox.cleanup()));
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Owned filesystem scene cleanup failed", { cause });
  }
}
