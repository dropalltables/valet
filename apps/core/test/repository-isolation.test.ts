import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectRepoVolumeName } from '../src/docker/client.js'

test('blank repository volumes are stable and isolated by project', () => {
  assert.equal(projectRepoVolumeName('project-a'), 'valet-repo-project-a')
  assert.notEqual(projectRepoVolumeName('project-a'), projectRepoVolumeName('project-b'))
})
