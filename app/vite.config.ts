import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isLocalOnlyEdition = mode === 'v1.1.2'
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@llm-review-dialog': fileURLToPath(new URL(
          isLocalOnlyEdition ? './src/LlmReviewDisabled.tsx' : './src/LlmReviewDialog.tsx',
          import.meta.url,
        )),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5187,
      strictPort: true,
    },
  }
})
