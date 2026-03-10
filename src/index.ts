/**
 * Central task runner.
 * Usage: tsx src/index.ts s01e01
 */

import "dotenv/config";

const [, , taskName] = process.argv;

if (!taskName) {
  console.log("Usage: npm run task <task-name>");
  console.log("Example: npm run task s01e01");
  process.exit(1);
}

try {
  const mod = await import(`./tasks/${taskName}.js`);
  if (typeof mod.run === "function") {
    await mod.run();
  } else {
    console.error(`Task "${taskName}" does not export a run() function`);
    process.exit(1);
  }
} catch (err: unknown) {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ERR_MODULE_NOT_FOUND"
  ) {
    console.error(`Task "${taskName}" not found.`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
