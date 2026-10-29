import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The client layer resolves the API base as:
  //   VITE_API_BASE_URL ?? (dev ? 'http://localhost:8080' : '')
  // (see src/api/client.js). In production the build is served same-origin
  // by the backend, so the base is empty; the tests exercise exactly that
  // shape — relative URLs, no dev-origin assumption.
  test: {
    env: {
      VITE_API_BASE_URL: '',
    },
  },
})
