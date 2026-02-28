import { defineConfig } from "vite";

function getEnv(): Record<string, string | undefined> {
  const maybeProcess = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return maybeProcess?.env ?? {};
}

function resolveBasePath(): string {
  const env = getEnv();
  if (env.DEPLOY_TARGET !== "github-pages") {
    return "/";
  }

  const repoName = env.GITHUB_REPOSITORY?.split("/")[1];
  return repoName ? `/${repoName}/` : "/";
}

export default defineConfig({
  base: resolveBasePath(),
  server: {
    host: true,
    port: 5173
  }
});
