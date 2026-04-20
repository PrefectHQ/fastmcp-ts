import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    server: 'src/server/index.ts',
    client: 'src/client/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
