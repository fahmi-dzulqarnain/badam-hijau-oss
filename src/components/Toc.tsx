import type { Heading } from "@/lib/markdown/toc";

export function Toc({ headings }: { headings: Heading[] }) {
  if (headings.length === 0) return null;

  return (
    <>
      <div className="railhead">On this page</div>
      <nav className="toc" aria-label="On this page">
        {headings.map((heading) => (
          <a key={heading.id} href={`#${heading.id}`} className={`depth-${heading.depth}`}>
            {heading.text}
          </a>
        ))}
      </nav>
    </>
  );
}
