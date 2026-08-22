"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, title }: { href: string; title: string }) {
  const pathname = usePathname();

  return (
    <Link href={href as Route} aria-current={pathname === href ? "page" : undefined}>
      {title}
    </Link>
  );
}
