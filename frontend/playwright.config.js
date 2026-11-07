import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  forbidOnly: !!process.env.CI,
  use: { baseURL: "http://127.0.0.1:4195", browserName: "chromium" },
  projects: [
    { name: "mobile", use: { viewport: { width: 390, height: 900 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "webkit-mobile", use: { browserName: "webkit", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4195 --strictPort",
    url: "http://127.0.0.1:4195",
  },
});
