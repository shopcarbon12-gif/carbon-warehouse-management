/**
 * Physical bin code grid for Orlando-style warehouse (location 001 in seed).
 * Keep in sync with `scripts/seed.ts` and `scripts/ensure-orlando-seed-bins.mjs`.
 */
export function generateOrlandoWarehouseBinCodes(): string[] {
  const out: string[] = [];
  const rows: { row: string; aisleCount: number }[] = [
    { row: "1", aisleCount: 11 },
    { row: "2", aisleCount: 8 },
    { row: "3", aisleCount: 8 },
    { row: "4", aisleCount: 8 },
    { row: "5", aisleCount: 8 },
    { row: "6", aisleCount: 2 },
  ];
  const sections = ["01", "02", "03", "04", "05"] as const;
  const positions = ["L", "C", "R"] as const;
  for (const { row, aisleCount } of rows) {
    for (let i = 0; i < aisleCount; i++) {
      const aisle = `${row}${String.fromCharCode(65 + i)}`;
      for (const sec of sections) {
        for (const pos of positions) {
          out.push(`${aisle}${sec}${pos}`);
        }
      }
    }
  }
  return out;
}
