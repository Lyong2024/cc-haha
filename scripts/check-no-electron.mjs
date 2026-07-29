#!/usr/bin/env node
/**
 * Ensures the pure-web product path does not depend on Electron.
 * Checks package.json dependency graphs for web-relevant packages.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const forbidden = new Set(['electron', 'electron-builder', 'electron-updater', 'electron-store'])

const targets = [
  join(root, 'package.json'),
  join(root, 'desktop', 'package.json'),
]

let failed = false

for (const packageJsonPath of targets) {
  if (!existsSync(packageJsonPath)) {
    console.log(`[skip] missing ${packageJsonPath}`)
    continue
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
  for (const section of sections) {
    const deps = pkg[section] || {}
    for (const name of Object.keys(deps)) {
      if (forbidden.has(name) || name.startsWith('electron-')) {
        // Root package may still list unrelated tools; only fail desktop/web product package.
        if (packageJsonPath.endsWith(`${join('desktop', 'package.json')}`) ||
            packageJsonPath.replace(/\\/g, '/').endsWith('desktop/package.json')) {
          console.error(`[fail] ${packageJsonPath} ${section} contains forbidden dependency: ${name}`)
          failed = true
        }
      }
    }
  }

  if (pkg.main && String(pkg.main).includes('electron')) {
    if (packageJsonPath.replace(/\\/g, '/').includes('/desktop/')) {
      console.error(`[fail] ${packageJsonPath} main points at electron: ${pkg.main}`)
      failed = true
    }
  }
}

// Electron source tree must not exist on web branch product path.
const electronPaths = [
  join(root, 'desktop', 'electron'),
  join(root, 'desktop', 'src-tauri'),
]
for (const p of electronPaths) {
  if (existsSync(p)) {
    console.error(`[fail] electron/desktop-shell path still exists: ${p}`)
    failed = true
  }
}

if (failed) {
  console.error('check-no-electron: FAILED')
  process.exit(1)
}

// packageManager should prefer pnpm on pure-web branch
for (const packageJsonPath of targets) {
  if (!existsSync(packageJsonPath)) continue
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (pkg.packageManager && !String(pkg.packageManager).startsWith('pnpm@')) {
    console.warn(`[warn] ${packageJsonPath} packageManager is ${pkg.packageManager} (expected pnpm@…)`)
  }
}

console.log('check-no-electron: OK')
