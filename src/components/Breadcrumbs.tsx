import Link from "next/link";

export function Breadcrumbs({
  spaceKey,
  spaceName,
  path,
}: {
  spaceKey: string;
  spaceName: string;
  path: string;
}) {
  const segments = path.split("/");
  const ancestors = segments.slice(0, -1);

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link href={`/${spaceKey}`}>{spaceName}</Link>
      {ancestors.map((segment, index) => (
        <span key={segment}>
          <span className="sep"> / </span>
          <Link href={`/${spaceKey}/${ancestors.slice(0, index + 1).join("/")}`}>
            {segment.replace(/-/g, " ")}
          </Link>
        </span>
      ))}
      <span className="sep">/</span>
      <span>{segments.at(-1)?.replace(/-/g, " ")}</span>
    </nav>
  );
}
