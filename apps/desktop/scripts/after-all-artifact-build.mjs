import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { resolveNotarizationConfig } from './notarize.mjs'

const SKIP_MESSAGE =
  'Skipping notarization for a non-release build: no complete Apple notarization credentials are configured.'
const NOTARIZE_ARTIFACT = fileURLToPath(new URL('./notarize-artifact.mjs', import.meta.url))

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr?.trim() || stdout?.trim() || error.message}`))
        return
      }
      resolve()
    })
  })
}

export function selectDmgArtifacts(artifactPaths, platform = process.platform) {
  if (platform !== 'darwin') return []
  return artifactPaths.filter(artifactPath => artifactPath.toLowerCase().endsWith('.dmg'))
}

export function planDmgNotarization({ artifactPaths, env = process.env, platform = process.platform }) {
  if (platform !== 'darwin') return { artifacts: [], skip: 'platform' }
  if (!resolveNotarizationConfig(env)) return { artifacts: [], skip: 'credentials' }
  return { artifacts: selectDmgArtifacts(artifactPaths, platform), skip: null }
}

export default async function afterAllArtifactBuild({ artifactPaths }) {
  const plan = planDmgNotarization({ artifactPaths })
  if (plan.skip === 'credentials') {
    console.log(SKIP_MESSAGE)
    return []
  }

  for (const artifactPath of plan.artifacts) {
    await run(process.execPath, [NOTARIZE_ARTIFACT, artifactPath])
    await run('xcrun', ['stapler', 'validate', artifactPath])
  }

  return []
}
