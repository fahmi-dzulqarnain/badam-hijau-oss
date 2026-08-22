import type { BuildInfo } from "@/lib/version/build";

export function TopBar({ build }: { build: BuildInfo }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">Badam</span>
        <span className="brand-channel">{build.channel}</span>
      </div>
    </header>
  );
}
