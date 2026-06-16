/**
 * Custom build script — uses Vite's programmatic API to produce three separate
 * bundles (content IIFE, background IIFE, popup HTML) into the dist/ directory.
 */
import { build } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';

const root = import.meta.dirname;
const distDir = resolve(root, 'dist');

async function main() {
  // 1. Build content script (IIFE — required by Chrome MV3 content scripts)
  console.log('  [1/3] Building content script...');
  await build({
    root,
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: true,
      lib: {
        entry: resolve(root, 'src/content/index.ts'),
        formats: ['iife'],
        name: 'ImmersiveTranslateContent',
        fileName: () => 'content.js',
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });

  // 2. Build background service worker (IIFE)
  console.log('  [2/3] Building background service worker...');
  await build({
    root,
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(root, 'src/background/index.ts'),
        formats: ['iife'],
        name: 'ImmersiveTranslateBackground',
        fileName: () => 'background.js',
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });

  // 3. Build popup (HTML entry — Vite handles CSS/JS automatically)
  console.log('  [3/3] Building popup...');
  await build({
    root,
    configFile: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      rollupOptions: {
        input: {
          popup: resolve(root, 'src/popup/index.html'),
        },
      },
    },
  });

  // 4. Fix popup output path — Vite outputs to src/popup/ but manifest expects popup/
  const srcPopupDir = resolve(distDir, 'src/popup');
  const destPopupDir = resolve(distDir, 'popup');
  if (existsSync(srcPopupDir)) {
    if (existsSync(destPopupDir)) {
      rmSync(destPopupDir, { recursive: true, force: true });
    }
    mkdirSync(resolve(distDir, 'popup'), { recursive: true });
    // Move the HTML
    renameSync(
      resolve(srcPopupDir, 'index.html'),
      resolve(destPopupDir, 'index.html')
    );
    // Clean up empty src/ dirs
    rmSync(srcPopupDir, { recursive: true, force: true });
    try {
      rmSync(resolve(distDir, 'src'), { recursive: true, force: true });
    } catch {
      // already empty or removed
    }
  }

  // 5. Copy manifest.json
  copyFileSync(resolve(root, 'src/manifest.json'), resolve(distDir, 'manifest.json'));

  console.log('✅ Build complete — load dist/ as an unpacked Chrome/Edge extension');
  console.log('   chrome://extensions → 开发者模式 → 加载已解压的扩展 → 选择 dist/ 文件夹');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
