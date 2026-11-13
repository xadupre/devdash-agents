import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface Repository {
  id: string;
  name: string;
  path: string;
}

export async function discoverRepositories(
  root: string,
): Promise<Repository[]> {
  const directory = resolve(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const repositories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(directory, entry.name);
        try {
          const git = await stat(join(path, ".git"));
          return git.isDirectory() || git.isFile()
            ? { id: path, name: entry.name, path }
            : undefined;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
          ) {
            return undefined;
          }
          throw error;
        }
      }),
  );
  return repositories
    .filter((repository): repository is Repository => repository !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}
