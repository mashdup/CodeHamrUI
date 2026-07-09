// Builds the codehamr fork into codehamr/dist/ with the harness's required
// build flags. GOEXPERIMENT=nogreenteagc disables the Green Tea GC that
// crash-loops on Windows 26xxx kernels (golang/go#76614: "traceback did not
// unwind completely" during GC stack scans) — observed live in this project.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = spawnSync('go', ['build', '-o', 'dist/', './cmd/codehamr'], {
  cwd: join(root, 'codehamr'),
  env: { ...process.env, GOEXPERIMENT: 'nogreenteagc' },
  stdio: 'inherit',
  shell: process.platform === 'win32', // resolve go.exe through PATH on Windows
})
process.exit(res.status ?? 1)
