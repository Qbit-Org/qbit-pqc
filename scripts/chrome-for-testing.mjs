import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Browser, Cache, computeExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers'

// Single source of truth for the Chrome for Testing build used by `pnpm test:mv3`.
// .github/workflows/ci.yml and the docs repeat the install command verbatim;
// test/chrome-for-testing-pin.test.mjs fails if any copy drifts from these values.
export const CHROME_FOR_TESTING_VERSION = '156.0.8078.47'
export const CHROME_FOR_TESTING_CACHE_DIR = '.context/browsers'
export const CHROME_FOR_TESTING_INSTALL_COMMAND = `pnpm exec browsers install chrome@${CHROME_FOR_TESTING_VERSION} --path ${CHROME_FOR_TESTING_CACHE_DIR}`

// The install command puts the build in <repoRoot>/<cache>/chrome/<platform>-<buildId>/,
// with the per-platform layout @puppeteer/browsers defines (read here without the
// cache's .metadata, which could redirect it). Only that path is accepted, so a
// stale or newer build, a build for another platform, or a binary planted in a
// parent directory cannot stand in for the pinned one.
export function findPinnedChromeForTesting(
  repoRoot,
  { platform = detectBrowserPlatform(), version = CHROME_FOR_TESTING_VERSION } = {}
) {
  if (platform === undefined) {
    return null
  }
  const executable = join(
    new Cache(join(repoRoot, CHROME_FOR_TESTING_CACHE_DIR)).installationDir(Browser.CHROME, platform, version),
    computeExecutablePath({ browser: Browser.CHROME, buildId: version, cacheDir: null, platform })
  )
  return existsSync(executable) ? executable : null
}

// `Browser` from Chrome's /json/version endpoint, e.g. "HeadlessChrome/156.0.8078.47".
export function browserMatchesVersion(browser, version = CHROME_FOR_TESTING_VERSION) {
  return typeof browser === 'string' && browser.split('/').at(-1) === version
}

// Chrome's Linux sandbox needs unprivileged user namespaces, which CI runners and
// hosts such as Ubuntu 23.10 and later (AppArmor) block. CI=true turns it off on
// Linux; CHROME_NO_SANDBOX=1 turns it off anywhere, and CHROME_NO_SANDBOX=0 keeps
// it on even in CI.
export function chromeSandboxFlags({ env = process.env, platform = process.platform } = {}) {
  const noSandbox = env.CHROME_NO_SANDBOX ?? ''
  if (!['', '0', '1'].includes(noSandbox)) {
    throw new Error(`CHROME_NO_SANDBOX must be 1 or 0, got ${JSON.stringify(noSandbox)}`)
  }
  // An explicit 0 keeps the sandbox on even in CI, where Linux runners get
  // --no-sandbox by default.
  if (noSandbox === '1' || (noSandbox === '' && platform === 'linux' && env.CI === 'true')) {
    return ['--no-sandbox', '--disable-setuid-sandbox']
  }
  return []
}
