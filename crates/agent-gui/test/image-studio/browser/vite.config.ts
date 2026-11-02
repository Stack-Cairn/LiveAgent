import { defineConfig, mergeConfig } from 'vite';
import gui from '../../../vite.config';
import path from 'node:path';
export default defineConfig(async env => mergeConfig(await (gui as any)(env), {
 root: path.resolve(__dirname), cacheDir: path.resolve(__dirname, '.vite'),
 server: { host: '127.0.0.1', port: 18473, strictPort: true, fs: { allow: [path.resolve(__dirname, '../../../../..')] } },
}));
