export function parseGitHubRepository(repoUrl) {
  let url;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error(`Invalid repository URL: ${repoUrl}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`Only public HTTPS GitHub repositories are supported: ${repoUrl}`);
  }
  const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Repository URL must point to a repository root: ${repoUrl}`);
  }
  const repository = parts[1].replace(/\.git$/, "");
  return Object.freeze({
    owner: parts[0],
    repository,
    slug: `${parts[0]}/${repository}`,
  });
}

export function githubRepositoryKey(repoUrl) {
  return parseGitHubRepository(repoUrl).slug.toLowerCase();
}
