import pkg from "../../../package.json";

export type BuildInfo = {
  version: string;
  gitSha: string | null;
  label: string;
  channel: "alpha";
};

export function buildInfo(env: Partial<NodeJS.ProcessEnv> = process.env): BuildInfo {
  const raw = env.GIT_SHA?.trim();
  const gitSha = raw && raw.length > 0 ? raw.slice(0, 7) : null;

  return {
    version: pkg.version,
    gitSha,
    label: `${pkg.version}+${gitSha ?? "dev"}`,
    channel: "alpha",
  };
}
