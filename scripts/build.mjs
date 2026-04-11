/**
 * Wrapper for `npm run build`.
 * Runs `db:migrate` first unless skipped, then runs `next build --webpack`.
 *
 * Skip migrations (no local Postgres, CI, Docker):
 *   SKIP_DB_MIGRATE=1 npm run build
 *   DOCKER_BUILD=1   npm run build   (also set by Dockerfile)
 */
import { execFileSync } from "child_process";

const skip =
  process.env.SKIP_DB_MIGRATE === "1" || process.env.DOCKER_BUILD === "1";

if (skip) {
  console.log(
    "[build] Skipping db:migrate (SKIP_DB_MIGRATE/DOCKER_BUILD is set).",
  );
} else {
  try {
    execFileSync("npm", ["run", "db:migrate"], { stdio: "inherit" });
  } catch (err) {
    console.error(
      "\n[build] db:migrate failed — is Postgres running? " +
        "Set SKIP_DB_MIGRATE=1 to skip migrations (e.g. CI without a local DB).\n",
    );
    process.exit(err?.status ?? 1);
  }
}

try {
  execFileSync(
    process.execPath,
    ["./node_modules/next/dist/bin/next", "build", "--webpack"],
    { stdio: "inherit" },
  );
} catch (err) {
  console.error("\n[build] next build failed.\n");
  process.exit(err?.status ?? 1);
}
