import Link from "next/link";
import type { Route } from "next";

type Ancestor = { path: string; title: string; isLinkable: boolean };

const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

export function Breadcrumbs({
  spaceKey,
  spaceName,
  ancestors,
  title,
}: {
  spaceKey: string;
  spaceName: string;
  ancestors: Ancestor[];
  title: string;
}) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        <li>
          <Link href={`/${encodeURIComponent(spaceKey)}` as Route}>{spaceName}</Link>
        </li>
        {ancestors.map((ancestor) => (
          <li key={ancestor.path}>
            <span className="sep">/</span>
            {ancestor.isLinkable ? (
              <Link
                href={`/${encodeURIComponent(spaceKey)}/${encodePath(ancestor.path)}` as Route}
              >
                {ancestor.title}
              </Link>
            ) : (
              <span>{ancestor.title}</span>
            )}
          </li>
        ))}
        <li>
          <span className="sep">/</span>
          <span aria-current="page">{title}</span>
        </li>
      </ol>
    </nav>
  );
}
