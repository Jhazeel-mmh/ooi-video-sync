"use client";

import { FolderSync, Home, Link2, Settings, Video } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/videos", label: "Videos", icon: Video },
  { href: "/workflows", label: "Workflows", icon: FolderSync },
  { href: "/accounts", label: "Cuentas", icon: Link2 },
  { href: "/settings", label: "Ajustes", icon: Settings },
] as const;

/** The active-link highlight needs the URL, which streams in after the static shell. */
export function NavLinks() {
  return (
    <Suspense fallback={<LinkList pathname={null} />}>
      <CurrentLinks />
    </Suspense>
  );
}

function CurrentLinks() {
  return <LinkList pathname={usePathname()} />;
}

function LinkList({ pathname }: { pathname: string | null }) {
  return (
    <nav className="flex gap-1 md:flex-col">
      {links.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : Boolean(pathname?.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            <span className="hidden sm:inline">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
