import { collectDirectoryListing } from "./directory-listing.js";

const directory = process.argv[2];

try {
  if (process.argv.length !== 3 || typeof directory !== "string") {
    throw new TypeError("Usage: directory-list-helper.js ABSOLUTE_DIRECTORY");
  }
  const listing = await collectDirectoryListing(directory);
  process.stdout.write(JSON.stringify(listing));
} catch (error) {
  process.stderr.write(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
