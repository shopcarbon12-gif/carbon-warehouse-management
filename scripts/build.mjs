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
  execFileSync("npm", ["run", "db:migrate"], { stdio: "inherit" });
}

execFileSync(
  process.execPath,
  ["./node_modules/next/dist/bin/next", "build", "--webpack"],
  { stdio: "inherit" },
);
