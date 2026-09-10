export async function releaseMenu(ask, latest, head, log = console.log) {
  const current = latest ?? '0.0.0'
  log(`Latest release: v${current}    HEAD: ${head}`)
  log('')
  log('  1) bump version')
  log(`  2) recreate last tag (v${current}) on HEAD   [force]`)
  log('  3) cancel')
  const action = await ask('> ')
  if (action === '2') {
    if (!latest) throw new Error('No release tag to recreate.')
    return { kind: 'recreate', version: latest }
  }
  if (action !== '1') {
    log('Cancelled.')
    return { kind: 'cancel' }
  }
  const [major, minor, patch] = current.split('.').map(Number)
  log('')
  log(`  1) major  -> v${major + 1}.0.0`)
  log(`  2) minor  -> v${major}.${minor + 1}.0`)
  log(`  3) patch  -> v${major}.${minor}.${patch + 1}`)
  const component = await ask('> ')
  const versions = {
    1: `${major + 1}.0.0`,
    2: `${major}.${minor + 1}.0`,
    3: `${major}.${minor}.${patch + 1}`,
  }
  const version = versions[component]
  if (!version) {
    log('Aborted.')
    return { kind: 'cancel' }
  }
  return { kind: 'bump', version }
}
