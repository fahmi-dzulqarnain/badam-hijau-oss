"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  title,
  isDraft,
}: {
  href: string;
  title: string;
  isDraft: boolean;
}) {
  const pathname = usePathname();

  return (
    <Link href={href as Route} aria-current={pathname === href ? "page" : undefined}>
      {title}
      {isDraft ? <span className="tag-draft">Draft</span> : null}
    </Link>
  );
}
