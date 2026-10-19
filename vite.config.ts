import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 4444,
    host: true,
  },
  preview: {
    port: 4444,
    host: true,
  },
});
