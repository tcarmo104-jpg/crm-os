import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Las pruebas de integración necesitan PostgREST + Postgres: se activan con scripts/test-postgrest.sh
    exclude: process.env.INTEGRATION ? ['node_modules/**'] : ['node_modules/**', '**/*.int.test.ts'],
    testTimeout: 30_000,
    // Las pruebas de integración comparten una base de datos: se ejecutan en serie
    fileParallelism: !process.env.INTEGRATION,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
