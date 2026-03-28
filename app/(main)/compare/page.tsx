import { CompareRunner } from "./compare-runner";

export default function ComparePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">
        RFID ↔ POS compare
      </h1>
      <p className="mt-1 font-mono text-sm text-[var(--muted)]">
        Persists a compare run and opens exceptions for line deltas (sample payload below).
      </p>
      <CompareRunner />
    </div>
  );
}
