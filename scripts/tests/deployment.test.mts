/**
 * The build must not be breakable by a test file.
 *
 * ── Why this suite exists ──────────────────────────────────────────────────────
 * The other suites assert what the app computes. This one asserts something about the *project*,
 * and it is here because the failure it guards against is both easy to cause and expensive: a
 * deployment that fails on a file which is not part of the app.
 *
 * The way it happens is never dramatic. Somebody widens `include` in `tsconfig.json` to pick up a
 * config file, or adds `npm test` to the build script so CI runs the suites, or drops a
 * `something.spec.ts` beside the code it tests. Each is a reasonable-looking edit. Each makes a red
 * deployment possible from a file the built bundle has never contained.
 *
 * So the guarantee is written down as assertions rather than left in a README paragraph:
 *
 *   1. **`tsc` cannot see test files.** Every test-file shape is excluded, not just the two that
 *      happened to exist when the exclude list was written.
 *   2. **The build command does not run tests.** `npm test` is a thing a person runs; a deployment
 *      that runs it can be broken by an assertion about arithmetic.
 *   3. **Nothing in `src` imports a test, a suite runner, or the reference server.** That is what
 *      actually keeps them out of the bundle — an ignore file only affects what gets uploaded.
 *
 * ── One thing worth knowing about `.vercelignore` ──────────────────────────────
 * It applies to **CLI uploads**. A deployment triggered from Git clones the whole repository, so
 * `scripts/` and `server-reference/` *are* present in that build environment. They still cannot
 * break it — because of the three assertions above, not because of the ignore file. The ignore file
 * keeps a CLI upload small; the exclusions are what keep the build green.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const root = process.cwd()
const read = (file: string) => readFileSync(join(root, file), 'utf8')

/* tsconfig is JSONC in principle; this one has no comments, and a parse failure is itself a fault. */
const tsconfig = JSON.parse(read('tsconfig.json')) as {
  include?: string[]
  exclude?: string[]
  compilerOptions?: Record<string, unknown>
}
const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }

/* ══════════════════════════════════════════ what the compiler can see ══ */

console.log('the type-check cannot see the tests')

const exclude = tsconfig.exclude ?? []
check('an exclude list exists', exclude.length > 0, `${exclude.length} patterns`)

/*
 * Every shape a test file comes in, not only the ones that exist today. A `.spec.ts` added next
 * month must be as invisible to the build as a `.test.mts` is now.
 */
for (const shape of [
  '**/*.test.ts',
  '**/*.test.mts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.mjs',
  '**/*.spec.ts',
  '**/*.spec.mts',
  '**/*.spec.tsx',
]) {
  check(`${shape} is excluded`, exclude.includes(shape))
}

/* The two directories that hold everything a deployment has no use for. */
check('scripts/ is excluded', exclude.includes('scripts'))
check('server-reference/ is excluded', exclude.includes('server-reference'))

/*
 * `include` is the other half. Widening it to the project root would pull `scripts` back in
 * whatever the exclusions say for the directory, so it stays a short, explicit list.
 */
const include = tsconfig.include ?? []
check('include is explicit, not the whole project', !include.includes('.') && !include.includes('**/*'), include.join(', '))
check('...and covers src', include.includes('src'))

/* ══════════════════════════════════════════════ what the build runs ══ */

console.log('\nthe build does not run the tests')

const build = pkg.scripts?.build ?? ''
check('a build script exists', build.length > 0, build)
check('it type-checks', build.includes('tsc --noEmit'), build)
check('it builds', build.includes('vite build'))
check('it does NOT run the suites', !/\btest\b/.test(build), build)
check('...nor the reference server', !build.includes('server-reference'))

/*
 * No install hook may run tests either. `postinstall` fires on Vercel before the build, so a suite
 * wired up there would fail a deployment earlier and more confusingly than one in `build`.
 */
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prebuild']) {
  const value = pkg.scripts?.[hook]
  check(`no ${hook} hook running tests`, !value || !/\btest\b/.test(value), value ?? 'absent')
}

/* ══════════════════════════════════════ what the bundle can reach ══ */

console.log('\nnothing in src reaches a test or the reference server')

/** Every source file, walked rather than globbed — no dependency, and it cannot miss a subfolder. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const sources = walk(join(root, 'src')).filter((file) => /\.(ts|tsx)$/.test(file))
check('src has source files to check', sources.length > 0, `${sources.length} files`)

/*
 * This is the assertion that actually keeps test code out of the shipped JavaScript. Vite bundles
 * by following imports from the entry point: a file nothing imports is not in the output, whatever
 * any ignore file says. So the thing to assert is that no import crosses out of `src`.
 */
const offenders: string[] = []
for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  /* Static imports, `export … from`, and dynamic `import()` alike. */
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const target = match[1]
    const forbidden =
      /\.test\b/.test(target) ||
      /\.spec\b/.test(target) ||
      target.includes('server-reference') ||
      target.includes('scripts/') ||
      target.includes('/tests/')
    if (forbidden) offenders.push(`${file.slice(root.length + 1)} → ${target}`)
  }
}
check('no src file imports a test, a suite, or the reference server', offenders.length === 0, offenders.join('; '))

/* Test files must live outside src, so `include: ["src"]` never has to reason about them at all. */
const straySuites = sources.filter((file) => /\.(test|spec)\.(ts|tsx)$/.test(file))
check(
  'no test files inside src',
  straySuites.length === 0,
  straySuites.map((f) => f.slice(root.length + 1)).join(', ') || 'none',
)

/* ══════════════════════════════════════════════ the upload, for CLI ══ */

console.log('\nthe CLI upload excludes them too')

const vercelignore = read('.vercelignore')
for (const line of ['scripts/', 'server-reference/', '.test-build/']) {
  check(`${line} is in .vercelignore`, vercelignore.includes(line))
}

const gitignore = read('.gitignore')
check('.test-build/ is not committed', gitignore.includes('.test-build/'))
check('dist/ is not committed', gitignore.includes('dist/'))

console.log()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
