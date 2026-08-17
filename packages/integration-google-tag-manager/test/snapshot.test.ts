import { describe, expect, it } from 'vitest'
import {
  buildLiveSnapshot,
  buildWorkspaceSnapshot,
  compareContainerSnapshots,
} from '../src/index.js'
import type { GtmContainerVersion, GtmTag, GtmWorkspace } from '../src/index.js'

const workspace: GtmWorkspace = {
  accountId: '1',
  containerId: '2',
  workspaceId: '3',
  path: 'accounts/1/containers/2/workspaces/3',
  name: 'Default Workspace',
  fingerprint: 'workspace-fingerprint',
}

const liveTag: GtmTag = {
  accountId: '1',
  containerId: '2',
  tagId: '10',
  path: 'accounts/1/containers/2/versions/7/tags/10',
  tagManagerUrl: 'https://tagmanager.google.com/live',
  fingerprint: 'same-content-live-fingerprint',
  name: 'Existing conversion',
  type: 'awct',
  parameter: [
    {
      key: 'nested',
      type: 'map',
      map: [{
        key: 'items',
        type: 'list',
        list: [{ type: 'template', value: '{{DLV - ecommerce.items}}' }],
      }],
    },
  ],
}

const draftExistingTag: GtmTag = {
  ...liveTag,
  workspaceId: '3',
  path: 'accounts/1/containers/2/workspaces/3/tags/10',
  tagManagerUrl: 'https://tagmanager.google.com/draft',
  fingerprint: 'same-content-draft-fingerprint',
}

function liveVersion(tags: GtmTag[]): GtmContainerVersion {
  return {
    accountId: '1',
    containerId: '2',
    containerVersionId: '7',
    path: 'accounts/1/containers/2/versions/7',
    fingerprint: 'version-fingerprint',
    tag: tags,
    trigger: [],
    variable: [],
    folder: [],
    builtInVariable: [],
  }
}

describe('live and draft snapshots', () => {
  it('preserves raw nested Parameter graphs and ignores only location metadata in comparisons', () => {
    const live = buildLiveSnapshot(liveVersion([liveTag]))
    const draft = buildWorkspaceSnapshot(workspace, {}, {
      tags: [draftExistingTag],
      triggers: [],
      variables: [],
      folders: [],
      builtInVariables: [],
    })
    const comparison = compareContainerSnapshots(live, draft)

    expect(draft.entities.tags[0]?.raw.parameter).toEqual(liveTag.parameter)
    expect(draft.entities.tags[0]?.checksum).not.toBe(live.entities.tags[0]?.checksum)
    expect(draft.entities.tags[0]?.contentChecksum).toBe(live.entities.tags[0]?.contentChecksum)
    expect(comparison.state).toBe('in-sync')
    expect(comparison.changes[0]).toMatchObject({
      status: 'unchanged',
      contentMatches: true,
      providerFingerprintMatches: false,
    })
  })

  it('reports a draft-only tag as an unpublished workspace change', () => {
    const draftOnlyTag: GtmTag = {
      accountId: '1',
      containerId: '2',
      workspaceId: '3',
      tagId: '11',
      name: 'Google Ads - Begin checkout',
      type: 'awct',
      parameter: [{ key: 'conversionValue', type: 'template', value: '{{DLV - ecommerce.value}}' }],
    }
    const live = buildLiveSnapshot(liveVersion([liveTag]))
    const draft = buildWorkspaceSnapshot(workspace, {
      workspaceChange: [{ changeStatus: 'added', tag: draftOnlyTag }],
    }, {
      tags: [draftExistingTag, draftOnlyTag],
      triggers: [],
      variables: [],
      folders: [],
      builtInVariables: [],
    })
    const comparison = compareContainerSnapshots(live, draft)

    expect(comparison).toMatchObject({
      state: 'unpublished-changes',
      hasUnpublishedChanges: true,
      hasConflicts: false,
    })
    expect(comparison.changes).toContainEqual(expect.objectContaining({
      kind: 'tag',
      id: '11',
      status: 'added',
    }))
    expect(comparison.workspaceChanges).toEqual([{ changeStatus: 'added', tag: draftOnlyTag }])
  })

  it('surfaces provider merge conflicts without trying to resolve them', () => {
    const live = buildLiveSnapshot(liveVersion([liveTag]))
    const conflict = {
      entityInBaseVersion: { changeStatus: 'updated', tag: liveTag },
      entityInWorkspace: { changeStatus: 'updated', tag: draftExistingTag },
    }
    const draft = buildWorkspaceSnapshot(workspace, { mergeConflict: [conflict] }, {
      tags: [draftExistingTag],
      triggers: [],
      variables: [],
      folders: [],
      builtInVariables: [],
    })

    expect(compareContainerSnapshots(live, draft)).toMatchObject({
      state: 'conflicted',
      hasUnpublishedChanges: true,
      hasConflicts: true,
      mergeConflicts: [conflict],
    })
  })
})
