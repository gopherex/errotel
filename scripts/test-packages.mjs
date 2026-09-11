import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'errotel-consumer-'))
try {
  const dependencies = { '@opentelemetry/api': '1.9.1' }
  for (const name of ['sdk', 'api']) {
    const pkg = JSON.parse(readFileSync(`packages/${name}/package.json`))
    dependencies[pkg.name] = `file:${resolve(`dist/release/errotel-${name}-${pkg.version}.tgz`)}`
  }
  writeFileSync(
    join(sandbox, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies })
  )
  // Yarn 1 caches file tarballs by location/version; a rebuilt same-version archive
  // must not accidentally test an older cached package. Keep this cache isolated.
  execFileSync('yarn', ['install', '--non-interactive', '--cache-folder', join(sandbox, 'cache')], {
    cwd: sandbox,
    stdio: 'inherit',
  })
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import * as sdk from '@gopherex/errotel-sdk';
    import { createOtlpClient } from '@gopherex/errotel-sdk/otlp';
    import { instrumentBrowser, createReactErrorHandler } from '@gopherex/errotel-sdk/browser';
    import { createClient, getCapabilities, investigate } from '@gopherex/errotel-api';
    assert.equal(typeof sdk.createClient, 'function');
    assert.equal(typeof createOtlpClient, 'function');
    assert.equal(typeof instrumentBrowser, 'function');
    assert.equal(typeof createReactErrorHandler, 'function');
    assert.equal(typeof sdk.redactKeys, 'function');
    assert.equal(typeof sdk.SDK_VERSION, 'string');
    const client = createClient({baseUrl:'http://example.invalid', fetch:async () =>
      new Response(JSON.stringify({source:'isolated-consumer'}),{headers:{'Content-Type':'application/json'}})});
    const result = await getCapabilities({client,throwOnError:true});
    assert.equal(result.data.source,'isolated-consumer');
    assert.equal(typeof investigate,'function');
    console.log('Published tarball imports and generated client request: OK');
  `,
    ],
    { cwd: sandbox, stdio: 'inherit' }
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
