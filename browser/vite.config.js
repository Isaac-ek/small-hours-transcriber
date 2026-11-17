import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const deployment = JSON.parse(
  readFileSync(new URL("./vercel.json", import.meta.url), "utf8"),
);
export default defineConfig({
  preview: {
    headers: Object.fromEntries(
      deployment.headers[0].headers.map(({ key, value }) => [key, value]),
    ),
  },
});
