import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { buildEnvGuard } from './scripts/build-env-guard.mjs'

export default defineConfig({
  plugins: [react(), buildEnvGuard()],
  test: {
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
})
