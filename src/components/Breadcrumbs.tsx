import Link from "next/link";
import { pageHref } from "@/lib/pages/href";

type Ancestor = { path: string; title: string; isLinkable: boolean };

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
          <Link href={pageHref(spaceKey)}>{spaceName}</Link>
        </li>
        {ancestors.map((ancestor) => (
          <li key={ancestor.path}>
            <span className="sep">/</span>
            {ancestor.isLinkable ? (
              <Link href={pageHref(spaceKey, ancestor.path)}>{ancestor.title}</Link>
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
