import { readFileSync } from "node:fs";

/** Tiny no-dependency .env loader: sets vars that aren't already in the environment. */
export function loadEnv(file = ".env") {
  try {
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith("#") && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env file — rely on real environment variables */
  }
}
