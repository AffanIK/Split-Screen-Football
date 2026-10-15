import { defineConfig } from 'vite';

export default defineConfig({
  // host: true lets a second laptop on the same network open the dev page.
  // A fixed port keeps the address stable.
  server: {
    port: 5190,
    strictPort: true,
    host: true,
    // The page never loads these. On Windows, watching a file while it is being
    // written can crash the dev server, so leave everything else alone.
    watch: { ignored: ['**/tests/**', '**/scripts/**', '**/*.md', '**/vercel.json', '**/render.yaml', '**/.git/**'] },
  },
});
