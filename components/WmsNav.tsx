import Link from "next/link";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/inventory", label: "Inventory & Stock" },
  { href: "/orders", label: "Orders & Fulfillment" },
  { href: "/reports", label: "Reports & Analytics" },
] as const;

export function WmsNav() {
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-[var(--surface-border)] bg-[var(--surface)]/60 px-4 py-2 md:px-6">
      {links.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className="rounded-md px-3 py-1.5 font-mono text-xs font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-border)]/40 hover:text-[var(--foreground)]"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
