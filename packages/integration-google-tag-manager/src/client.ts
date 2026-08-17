import { GTM_API_BASE, GTM_MAX_PAGES } from './constants.js'
import { gtmFetchGet } from './http.js'
import { buildLiveSnapshot, buildWorkspaceSnapshot, compareContainerSnapshots } from './snapshot.js'
import { GtmApiError } from './types.js'
import type {
  GoogleTagManagerClient,
  GtmAccount,
  GtmBuiltInVariable,
  GtmClientOptions,
  GtmContainer,
  GtmContainerVersion,
  GtmFolder,
  GtmTag,
  GtmTrigger,
  GtmVariable,
  GtmWorkspace,
  GtmWorkspaceStatus,
} from './types.js'

type ResourcePathKind = 'account' | 'container' | 'workspace'

// Keep this aligned with the public GTM ID canonicalizers. These paths are
// interpolated into URL objects, so dot segments and URL delimiters must never
// reach URL normalization.
const GTM_ID_SEGMENT = String.raw`[\w-]+`
const PATH_PATTERNS: Record<ResourcePathKind, RegExp> = {
  account: new RegExp(`^accounts/${GTM_ID_SEGMENT}$`),
  container: new RegExp(`^accounts/${GTM_ID_SEGMENT}/containers/${GTM_ID_SEGMENT}$`),
  workspace: new RegExp(
    `^accounts/${GTM_ID_SEGMENT}/containers/${GTM_ID_SEGMENT}/workspaces/${GTM_ID_SEGMENT}$`,
  ),
}

function assertAccessToken(accessToken: string): void {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw new GtmApiError('OAuth access token is required', 400, { reason: 'INVALID_ACCESS_TOKEN' })
  }
}

function assertPath(path: string, kind: ResourcePathKind): void {
  if (!PATH_PATTERNS[kind].test(path)) {
    throw new GtmApiError(`Invalid Tag Manager ${kind} resource path`, 400, {
      reason: 'INVALID_RESOURCE_PATH',
    })
  }
}

function apiUrl(path: string, pageToken?: string): string {
  const url = new URL(`${GTM_API_BASE}/${path}`)
  if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken)
  return url.toString()
}

async function listCollection<T>(
  accessToken: string,
  path: string,
  responseKey: string,
  options: GtmClientOptions,
): Promise<T[]> {
  const collected: T[] = []
  const seenTokens = new Set<string>()
  let pageToken: string | undefined

  for (let page = 0; page < GTM_MAX_PAGES; page++) {
    const response = await gtmFetchGet<Record<string, unknown>>(apiUrl(path, pageToken), accessToken, options)
    const values = response[responseKey]
    if (values !== undefined && !Array.isArray(values)) {
      throw new GtmApiError(`Tag Manager returned an invalid ${responseKey} list`, 502, {
        reason: 'INVALID_PROVIDER_RESPONSE',
      })
    }
    collected.push(...((values ?? []) as T[]))

    const nextPageToken = response.nextPageToken
    if (nextPageToken === undefined || nextPageToken === '') return collected
    if (typeof nextPageToken !== 'string' || seenTokens.has(nextPageToken)) {
      throw new GtmApiError('Tag Manager returned an invalid pagination token', 502, {
        reason: 'INVALID_PROVIDER_PAGINATION',
      })
    }
    seenTokens.add(nextPageToken)
    pageToken = nextPageToken
  }

  throw new GtmApiError('Tag Manager pagination exceeded the safety limit', 502, {
    reason: 'PAGINATION_LIMIT_EXCEEDED',
  })
}

/**
 * Create a Tag Manager v2 reader. The returned surface intentionally exposes
 * no create/update/delete/version/publish methods.
 */
export function createGoogleTagManagerClient(
  accessToken: string,
  options: GtmClientOptions = {},
): GoogleTagManagerClient {
  assertAccessToken(accessToken)

  const listAccounts = (): Promise<GtmAccount[]> =>
    listCollection<GtmAccount>(accessToken, 'accounts', 'account', options)

  const listContainers = async (accountPath: string): Promise<GtmContainer[]> => {
    assertPath(accountPath, 'account')
    return listCollection<GtmContainer>(accessToken, `${accountPath}/containers`, 'container', options)
  }

  const listWorkspaces = async (containerPath: string): Promise<GtmWorkspace[]> => {
    assertPath(containerPath, 'container')
    return listCollection<GtmWorkspace>(accessToken, `${containerPath}/workspaces`, 'workspace', options)
  }

  const getLiveContainerVersion = async (containerPath: string): Promise<GtmContainerVersion> => {
    assertPath(containerPath, 'container')
    return gtmFetchGet<GtmContainerVersion>(
      `${GTM_API_BASE}/${containerPath}/versions:live`,
      accessToken,
      options,
    )
  }

  const getLiveSnapshot: GoogleTagManagerClient['getLiveSnapshot'] = async (containerPath) =>
    buildLiveSnapshot(await getLiveContainerVersion(containerPath))

  const getWorkspaceSnapshot: GoogleTagManagerClient['getWorkspaceSnapshot'] = async (workspacePath) => {
    assertPath(workspacePath, 'workspace')
    const [workspace, status, tags, triggers, variables, folders, builtInVariables] = await Promise.all([
      gtmFetchGet<GtmWorkspace>(`${GTM_API_BASE}/${workspacePath}`, accessToken, options),
      gtmFetchGet<GtmWorkspaceStatus>(`${GTM_API_BASE}/${workspacePath}/status`, accessToken, options),
      listCollection<GtmTag>(accessToken, `${workspacePath}/tags`, 'tag', options),
      listCollection<GtmTrigger>(accessToken, `${workspacePath}/triggers`, 'trigger', options),
      listCollection<GtmVariable>(accessToken, `${workspacePath}/variables`, 'variable', options),
      listCollection<GtmFolder>(accessToken, `${workspacePath}/folders`, 'folder', options),
      listCollection<GtmBuiltInVariable>(
        accessToken,
        `${workspacePath}/built_in_variables`,
        'builtInVariable',
        options,
      ),
    ])
    return buildWorkspaceSnapshot(workspace, status, { tags, triggers, variables, folders, builtInVariables })
  }

  const compareLiveAndWorkspace: GoogleTagManagerClient['compareLiveAndWorkspace'] = async (
    containerPath,
    workspacePath,
  ) => {
    const [live, workspace] = await Promise.all([
      getLiveSnapshot(containerPath),
      getWorkspaceSnapshot(workspacePath),
    ])
    return compareContainerSnapshots(live, workspace)
  }

  return {
    listAccounts,
    listContainers,
    listWorkspaces,
    getLiveContainerVersion,
    getLiveSnapshot,
    getWorkspaceSnapshot,
    compareLiveAndWorkspace,
  }
}
