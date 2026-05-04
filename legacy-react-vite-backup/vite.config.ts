import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const iconsSrcDir = path.resolve(projectRoot, 'src/assets/icons')

/** Serve `src/assets/icons` at `/icons/*` in dev and copy into `dist/icons` after build (stable URLs for manifest / favicons). */
function srcAssetsIconsPlugin(): Plugin {
  const mimeByExt: Record<string, string> = {
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }

  return {
    name: 'src-assets-icons',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0]
        if (!pathname?.startsWith('/icons/')) return next()
        const rawName = pathname.slice('/icons/'.length)
        if (!rawName || rawName.includes('..') || /[/\\]/.test(rawName)) return next()
        const filePath = path.join(iconsSrcDir, rawName)
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next()
        const ext = path.extname(rawName).toLowerCase()
        res.setHeader('Content-Type', mimeByExt[ext] ?? 'application/octet-stream')
        fs.createReadStream(filePath).pipe(res)
      })
    },
    closeBundle() {
      if (!fs.existsSync(iconsSrcDir)) return
      const distIcons = path.resolve(projectRoot, 'dist/icons')
      fs.mkdirSync(distIcons, { recursive: true })
      for (const name of fs.readdirSync(iconsSrcDir)) {
        const srcFile = path.join(iconsSrcDir, name)
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, path.join(distIcons, name))
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), srcAssetsIconsPlugin()],
})
