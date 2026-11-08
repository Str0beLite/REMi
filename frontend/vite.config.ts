import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // `npm run dev`: onboarding talks to a node run by hand (uv run python -m remi), like nginx does in Docker
  server: { proxy: { '/setup': 'http://localhost:7078' } },
})
