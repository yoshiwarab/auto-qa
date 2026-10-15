import { defineConfig } from "@playwright/test";

export default defineConfig({
  projects: [
    { name: "chromium" },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
