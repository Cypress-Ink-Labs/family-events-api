import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022",
      },
      module: { type: "es6" },
    }),
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    // AppModule validates env at import time; provide a harmless default so
    // bootstrap tests can run without external services.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/na",
    },
  },
});
