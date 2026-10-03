import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'

test('consumer ZIP refuses unsafe package contents and stays reproducible without claiming live acceptance', () => {
  expect(() => execFileSync('python3', ['tests/plugin-package/test_package.py'], { stdio: 'pipe' })).not.toThrow()
})
