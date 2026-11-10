"use client";

/** Creative → Library (spec §2.4): every CARBON creative and campaign, scheduled / posted, with real results. */
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { chip, CreativeShell, fetcher, head, KIND_LABEL, Media, money, muted, STATUS_LABEL } from "./ui";

type P = {
  id: string; title: string; kind: string; role: string | null; status: string; campaign_id: string | null; campaign_name: string | null; spend: number; cover: string | null; video: string | null; updated_at: string; feedback: string | null;
  posts: { postId: string; status: string; scheduledAt: string | null; results: { score?: number | null; reach?: number | null; views?: number | null; saves?: number | null; shares?: number | null } | null; sales: { orders: number; total: number } | null }[] | null;
};

export function CreativeLibrary() {
  const { data } = useSWR<{ projects: P[] }>("/api/creative/projects", fetcher, { refreshInterval: 20000 });
  const [f, setF] = useState<"all" | "final" | "draft" | "posted" | "campaigns">("all");
  const list = useMemo(() => {
    const all = data?.projects ?? [];
    if (f === "final") return all.filter((p) => p.status === "final");
    if (f === "draft") return all.filter((p) => p.status !== "final");
    if (f === "posted") return all.filter((p) => p.posts?.length);
    if (f === "campaigns") return all.filter((p) => p.campaign_id);
    return all;
  }, [data, f]);
  const groups = useMemo(() => {
    if (f !== "campaigns") return [{ name: null as string | null, items: list }];
    const m = new Map<string, P[]>();
    for (const p of list) m.set(p.campaign_name ?? p.campaign_id ?? "", [...(m.get(p.campaign_name ?? p.campaign_id ?? "") ?? []), p]);
    return [...m.entries()].map(([name, items]) => ({ name, items }));
  }, [list, f]);
  return (
    <CreativeShell>
      <h1 className={`${head} mb-3 text-4xl md:text-5xl`}>Library</h1>
      <div className="mb-4 flex flex-wrap gap-2">
        {(["all", "final", "draft", "posted", "campaigns"] as const).map((k) => <button key={k} className={chip(f === k)} onClick={() => setF(k)}>{k === "draft" ? "In progress" : k}</button>)}
      </div>
      {!data ? <p className={muted}>Loading…</p> : !list.length ? <p className={`text-sm ${muted}`}>— Nothing here yet. <Link className="underline" href="/creative/create">Create something</Link>.</p> : null}
      {groups.map((g) => (
        <section key={g.name ?? "all"} className="mb-6">
          {g.name ? <h2 className={`${head} mb-2 text-xl`}>{g.name}</h2> : null}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {g.items.map((p) => {
              const post = p.posts?.[0];
              return (
                <Link key={p.id} href={`/creative/create?project=${p.id}`} className="block border border-white/10 bg-[#0d0d0d] hover:border-white/40">
                  <Media url={p.video ?? p.cover} video={Boolean(p.video)} poster={p.cover} className="aspect-[4/5] w-full" />
                  <div className="p-2">
                    <p className="truncate text-sm font-semibold">{p.title || KIND_LABEL[p.kind]}</p>
                    <p className={`text-xs ${muted}`}>{KIND_LABEL[p.kind]}{p.role ? ` · ${p.role}` : ""} · {STATUS_LABEL[p.status] ?? p.status} · {money(p.spend)}</p>
                    {post ? (
                      <p className="mt-1 text-xs">
                        {post.status === "published" ? "Posted" : post.scheduledAt ? `Scheduled ${new Date(post.scheduledAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : post.status}
                        {post.results ? ` · reach ${post.results.reach ?? "—"} · saves ${post.results.saves ?? "—"} · shares ${post.results.shares ?? "—"}` : ""}
                        {post.sales ? ` · ${post.sales.orders} online orders in 48 h (correlation)` : ""}
                      </p>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </CreativeShell>
  );
}
