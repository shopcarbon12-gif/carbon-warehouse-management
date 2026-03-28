import Link from "next/link";

export default function RfidPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">RFID workflows</h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Deep encode and LS PO flows can stay in Senitron; this app links operators back to inventory
        and exceptions.
      </p>
      <ul className="mt-6 list-inside list-disc space-y-2 font-mono text-sm text-[var(--foreground)]">
        <li>
          <a
            href="https://app.senitron.net/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            Open Senitron (encode / PO)
          </a>
        </li>
        <li>
          <Link href="/inventory" className="text-[var(--accent)] hover:underline">
            Search inventory
          </Link>
        </li>
        <li>
          <Link href="/handheld" className="text-[var(--accent)] hover:underline">
            Handheld batch API
          </Link>
        </li>
      </ul>
    </div>
  );
}
