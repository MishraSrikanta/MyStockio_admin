/**
 * Runs the pure-logic suites under scripts/tests.
 *
 *   npm run test:lib
 *
 * Bundles each .test.mts with esbuild — they import app source, which is TypeScript with a path
 * alias — then runs it in node. No framework: these files assert arithmetic and string building,
 * and a runner for four files is not worth a dependency.
 *
 * Falls back to a sibling project's esbuild when this one has no node_modules yet, so the suites
 * can be run before `npm install` has been done here.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const testDir = join(here, 'tests')
const outDir = join(here, '.test-build')

const CANDIDATES = [
  join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(root, '..', 'IMS- (Inventory management system)', 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(root, '..', 'mycodescan', 'node_modules', 'esbuild', 'bin', 'esbuild'),
]
const esbuild = CANDIDATES.find((path) => existsSync(path))

if (!esbuild) {
  console.error('No esbuild found. Run `npm install` in this folder first.')
  process.exit(1)
}

const suites = readdirSync(testDir).filter((name) => name.endsWith('.test.mts')).sort()
if (suites.length === 0) {
  console.log('No suites in scripts/tests.')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
let failed = 0

for (const suite of suites) {
  const name = suite.replace(/\.test\.mts$/, '')
  const built = join(outDir, `${name}.mjs`)
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`)

  try {
    execFileSync(
      process.execPath,
      [
        esbuild,
        join(testDir, suite),
        '--bundle',
        '--format=esm',
        '--platform=node',
        `--outfile=${built}`,
        '--log-level=error',
        /* The app reads import.meta.env, which does not exist outside Vite. */
        '--define:import.meta.env={"DEV":false,"MODE":"test"}',
      ],
      { stdio: 'inherit' },
    )
  } catch {
    console.log(`FAILED to build ${suite}`)
    failed += 1
    continue
  }

  try {
    execFileSync(process.execPath, [built], { stdio: 'inherit' })
  } catch {
    failed += 1
  }
}

rmSync(outDir, { recursive: true, force: true })
console.log()
if (failed > 0) {
  console.log(`${failed} of ${suites.length} suite(s) failed.`)
  process.exitCode = 1
} else {
  console.log(`All ${suites.length} suite(s) passed.`)
}
