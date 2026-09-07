import { describe, expect, it, vi } from 'vitest';
import { AppStoreConnectAdapter } from '../appstoreconnect.adapter.js';

function adapterWithApiMock() {
  const adapter = new AppStoreConnectAdapter();
  const apiRequest = vi.fn();
  (adapter as unknown as { apiRequest: typeof apiRequest }).apiRequest = apiRequest;
  return { adapter, apiRequest };
}

const ASC_API = 'https://api.appstoreconnect.apple.com/v1';

function betaGroup(id: string, name: string) {
  return {
    id,
    attributes: { name, isInternalGroup: false },
  };
}

function bundleId(id: string, identifier: string) {
  return {
    id,
    attributes: { identifier, name: `Bundle ${id}`, platform: 'IOS' },
  };
}

function reviewSubmission(id: string, state = 'READY_FOR_REVIEW', platform = 'IOS') {
  return {
    id,
    attributes: { state, platform },
  };
}

describe('AppStoreConnectAdapter TestFlight management', () => {
  it('distinguishes an unattached build from a failed App Store observation', async () => {
    const absent = adapterWithApiMock();
    absent.apiRequest.mockResolvedValueOnce({ data: null });
    await expect(absent.adapter.getAppStoreVersionBuild('version-1')).resolves.toBeNull();

    const unavailable = adapterWithApiMock();
    unavailable.apiRequest.mockRejectedValueOnce(new Error('App Store API unavailable'));
    await expect(unavailable.adapter.getAppStoreVersionBuild('version-1'))
      .rejects.toThrow('App Store API unavailable');
  });

  it('lists App Store versions without the unsupported sort parameter', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({ data: [] });

    await adapter.listAppStoreVersions('app-1', { platform: 'IOS', limit: 10 });

    const requestPath = apiRequest.mock.calls[0][1] as string;
    const requestUrl = new URL(requestPath, 'https://api.appstoreconnect.apple.com');
    expect(requestUrl.pathname).toBe('/apps/app-1/appStoreVersions');
    expect(requestUrl.searchParams.get('filter[platform]')).toBe('IOS');
    expect(requestUrl.searchParams.has('sort')).toBe(false);
  });

  it('hard-bounds App Store version results when the API over-returns', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    const version = (id: string) => ({
      id,
      attributes: {
        versionString: '1.0',
        appStoreState: 'READY_FOR_SALE',
        platform: 'IOS',
      },
    });
    apiRequest.mockResolvedValueOnce({ data: [version('version-1'), version('version-2')] });

    await expect(adapter.listAppStoreVersions('app-1', { limit: 1 })).resolves.toHaveLength(1);
  });

  it('parses builds when App Store Connect omits preReleaseVersion relationships', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [{
        id: 'build-7',
        attributes: {
          version: '7',
          uploadedDate: '2026-06-03T18:00:00Z',
          processingState: 'VALID',
          usesNonExemptEncryption: null,
        },
      }],
      included: [],
    });

    const builds = await adapter.listBuilds({ appId: 'app-1', limit: 1 });

    expect(builds).toEqual([{
      id: 'build-7',
      version: '',
      buildNumber: '7',
      processingState: 'VALID',
      usesNonExemptEncryption: null,
      uploadedDate: '2026-06-03T18:00:00Z',
      appId: '',
    }]);
  });

  it('hard-bounds build results when App Store Connect over-returns', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    const build = (id: string) => ({
      id,
      attributes: {
        version: id,
        uploadedDate: '2026-06-03T18:00:00Z',
        processingState: 'VALID',
        usesNonExemptEncryption: null,
      },
    });
    apiRequest.mockResolvedValueOnce({ data: [build('build-1'), build('build-2')], included: [] });

    await expect(adapter.listBuilds({ limit: 1 })).resolves.toHaveLength(1);
    expect(new URL(String(apiRequest.mock.calls[0][1]), ASC_API).searchParams.get('limit')).toBe('1');
  });

  it('creates beta groups linked to an app', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: {
        id: 'group-1',
        attributes: {
          name: 'External Testers',
          isInternalGroup: false,
          publicLinkEnabled: true,
          publicLink: 'https://testflight.apple.com/join/example',
          publicLinkLimit: 100,
          feedbackEnabled: true,
        },
      },
    });

    const group = await adapter.createBetaGroup({
      appId: 'app-1',
      name: 'External Testers',
      publicLinkEnabled: true,
      publicLinkLimit: 100,
      feedbackEnabled: true,
    });

    expect(group).toMatchObject({
      id: 'group-1',
      name: 'External Testers',
      isInternal: false,
      publicLinkEnabled: true,
    });
    expect(apiRequest).toHaveBeenCalledWith('POST', '/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes: {
          name: 'External Testers',
          isInternalGroup: false,
          feedbackEnabled: true,
          publicLinkEnabled: true,
          publicLinkLimitEnabled: true,
          publicLinkLimit: 100,
        },
        relationships: {
          app: {
            data: { type: 'apps', id: 'app-1' },
          },
        },
      },
    });
  });

  it('creates beta testers with app, group, and build relationships', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: {
        id: 'tester-1',
        attributes: {
          email: 'tester@example.com',
          firstName: 'Test',
          lastName: 'User',
          state: 'INVITED',
        },
      },
    });

    const tester = await adapter.createBetaTester({
      email: 'tester@example.com',
      firstName: 'Test',
      lastName: 'User',
      appIds: ['app-1'],
      groupIds: ['group-1'],
    });

    expect(tester).toMatchObject({
      id: 'tester-1',
      email: 'tester@example.com',
      firstName: 'Test',
      lastName: 'User',
    });
    expect(apiRequest).toHaveBeenCalledWith('POST', '/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: {
          email: 'tester@example.com',
          firstName: 'Test',
          lastName: 'User',
        },
        relationships: {
          apps: {
            data: [{ type: 'apps', id: 'app-1' }],
          },
          betaGroups: {
            data: [{ type: 'betaGroups', id: 'group-1' }],
          },
        },
      },
    });
  });

  it('links existing testers to groups', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValue({});

    await adapter.addBetaTesterToBetaGroups('tester-1', ['group-1', 'group-2']);

    expect(apiRequest).toHaveBeenCalledWith('POST', '/betaTesters/tester-1/relationships/betaGroups', {
      data: [
        { type: 'betaGroups', id: 'group-1' },
        { type: 'betaGroups', id: 'group-2' },
      ],
    });
  });

  it('lists beta testers from a group with email filtering', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [{
        id: 'tester-1',
        attributes: {
          email: 'tester@example.com',
          state: 'ACCEPTED',
        },
      }],
    });

    const testers = await adapter.listBetaTesters({
      groupId: 'group-1',
      email: 'tester@example.com',
      limit: 25,
    });

    expect(testers).toEqual([{
      id: 'tester-1',
      email: 'tester@example.com',
      firstName: undefined,
      lastName: undefined,
      inviteType: undefined,
      state: 'ACCEPTED',
    }]);
    expect(apiRequest.mock.calls[0][0]).toBe('GET');
    expect(apiRequest.mock.calls[0][1]).toContain('/betaGroups/group-1/betaTesters?');
    expect(apiRequest.mock.calls[0][1]).not.toContain('filter%5Bemail%5D=');
  });

  it('filters grouped testers before enforcing the local result bound', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [
        { id: 'tester-1', attributes: { email: 'other@example.com' } },
        { id: 'tester-2', attributes: { email: 'selected@example.com' } },
        { id: 'tester-3', attributes: { email: 'selected@example.com' } },
      ],
    });

    await expect(adapter.listBetaTesters({
      groupId: 'group-1',
      email: 'selected@example.com',
      limit: 1,
    })).resolves.toEqual([
      expect.objectContaining({ id: 'tester-2', email: 'selected@example.com' }),
    ]);
  });
});

describe('AppStoreConnectAdapter mutation-safe lookup pagination', () => {
  it('finds a beta group on a later page instead of creating a duplicate', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    const next = `${ASC_API}/apps/app-1/betaGroups?cursor=second`;
    apiRequest
      .mockResolvedValueOnce({ data: [betaGroup('group-other', 'Other')], links: { next } })
      .mockResolvedValueOnce({ data: [betaGroup('group-target', 'External Testers')] });

    const result = await adapter.getOrCreateBetaGroup({
      appId: 'app-1',
      name: 'External Testers',
    });

    expect(result).toMatchObject({ created: false, group: { id: 'group-target' } });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest.mock.calls[0][0]).toBe('GET');
    expect(apiRequest.mock.calls[0][1]).toContain('/apps/app-1/betaGroups?');
    expect(apiRequest.mock.calls[1]).toEqual(['GET', next]);
  });

  it('blocks ambiguous beta group names before mutation', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [
        betaGroup('group-1', 'External Testers'),
        betaGroup('group-2', 'external testers'),
      ],
    });

    await expect(adapter.getOrCreateBetaGroup({
      appId: 'app-1',
      name: 'External Testers',
    })).rejects.toThrow('Multiple TestFlight beta groups');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed beta group pages instead of planning a create from absence', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({ data: null });

    await expect(adapter.getOrCreateBetaGroup({
      appId: 'app-1',
      name: 'External Testers',
    })).rejects.toThrow('malformed beta-group list response');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a beta group creation receipt for a different identity', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({ data: betaGroup('group-1', 'Wrong Name') });

    await expect(adapter.createBetaGroup({
      appId: 'app-1',
      name: 'External Testers',
    })).rejects.toThrow('creation outcome is unknown');
  });

  it('finds a bundle identifier on a later filtered page', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    const next = `${ASC_API}/bundleIds?cursor=second`;
    apiRequest
      .mockResolvedValueOnce({ data: [bundleId('bundle-other', 'com.example.other')], links: { next } })
      .mockResolvedValueOnce({ data: [bundleId('bundle-target', 'com.example.app')] });

    await expect(adapter.findBundleIdByIdentifier('com.example.app')).resolves.toMatchObject({
      id: 'bundle-target',
      identifier: 'com.example.app',
    });
    const firstUrl = new URL(apiRequest.mock.calls[0][1] as string, ASC_API);
    expect(firstUrl.searchParams.get('filter[identifier]')).toBe('com.example.app');
    expect(apiRequest.mock.calls[1]).toEqual(['GET', next]);
  });

  it('blocks duplicate bundle identifier matches', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [
        bundleId('bundle-1', 'com.example.app'),
        bundleId('bundle-2', 'com.example.app'),
      ],
    });

    await expect(adapter.findBundleIdByIdentifier('com.example.app')).rejects.toThrow(
      'Multiple App Store Connect Bundle ID resources'
    );
  });

  it('rejects malformed bundle-id pages instead of treating them as empty', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({ data: [{ id: 'bundle-1', attributes: {} }] });

    await expect(adapter.findBundleIdByIdentifier('com.example.app')).rejects.toThrow(
      'malformed bundle-id list response'
    );
  });

  it('uses the exact app-scoped review endpoint and reuses a later-page submission', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    const next = `${ASC_API}/apps/app-1/reviewSubmissions?cursor=second`;
    apiRequest
      .mockResolvedValueOnce({
        data: [reviewSubmission('review-complete', 'COMPLETE')],
        links: { next },
      })
      .mockResolvedValueOnce({ data: [reviewSubmission('review-ready')] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ data: reviewSubmission('review-ready', 'WAITING_FOR_REVIEW') });

    const result = await adapter.submitForReview({
      appId: 'app-1',
      appStoreVersionId: 'version-1',
      platform: 'IOS',
    });

    expect(result).toMatchObject({
      reusedExistingSubmission: true,
      reviewSubmission: { id: 'review-ready', state: 'WAITING_FOR_REVIEW' },
    });
    const firstUrl = new URL(apiRequest.mock.calls[0][1] as string, ASC_API);
    expect(firstUrl.pathname).toBe('/apps/app-1/reviewSubmissions');
    expect(firstUrl.searchParams.has('filter[app]')).toBe(false);
    expect(firstUrl.searchParams.has('filter[state]')).toBe(false);
    expect(apiRequest.mock.calls[1]).toEqual(['GET', next]);
    expect(apiRequest.mock.calls.some((call) => call[0] === 'POST' && call[1] === '/reviewSubmissions')).toBe(false);
  });

  it('blocks multiple reusable review submissions before adding an item', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [reviewSubmission('review-1'), reviewSubmission('review-2')],
    });

    await expect(adapter.submitForReview({
      appId: 'app-1',
      appStoreVersionId: 'version-1',
      platform: 'IOS',
    })).rejects.toThrow('Multiple READY_FOR_REVIEW submissions');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('treats unfamiliar review states as in-flight instead of creating another submission', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [reviewSubmission('review-new-state', 'AWAITING_EXPORT_REVIEW')],
    });

    await expect(adapter.submitForReview({
      appId: 'app-1',
      appStoreVersionId: 'version-1',
      platform: 'IOS',
    })).rejects.toThrow('already AWAITING_EXPORT_REVIEW');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed review pages before creating a submission', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [{ id: 'review-1', attributes: { state: 'READY_FOR_REVIEW' } }],
    });

    await expect(adapter.submitForReview({
      appId: 'app-1',
      appStoreVersionId: 'version-1',
      platform: 'IOS',
    })).rejects.toThrow('malformed review-submission list response');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a review submission creation receipt for the wrong platform', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({ data: reviewSubmission('review-1', 'READY_FOR_REVIEW', 'MAC_OS') });

    await expect(adapter.createReviewSubmission('app-1', 'IOS')).rejects.toThrow(
      'creation outcome is unknown'
    );
  });

  it('fails closed when App Store pagination cycles to a previously seen page', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    const initial = `${ASC_API}/bundleIds?limit=200&fields%5BbundleIds%5D=identifier%2Cname%2Cplatform`;
    const second = `${ASC_API}/bundleIds?cursor=second`;
    apiRequest
      .mockResolvedValueOnce({ data: [], links: { next: second } })
      .mockResolvedValueOnce({ data: [], links: { next: initial } });

    await expect(adapter.listBundleIds()).rejects.toThrow('pagination repeated a page');
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('does not follow pagination links outside the App Store Connect API', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [],
      links: { next: 'https://attacker.example/steal-token' },
    });

    await expect(adapter.listBetaGroups('app-1')).rejects.toThrow('unsafe beta-group list pagination link');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('does not let a next link change the app-scoped collection identity', async () => {
    const { adapter, apiRequest } = adapterWithApiMock();
    apiRequest.mockResolvedValueOnce({
      data: [],
      links: { next: `${ASC_API}/apps/app-2/betaGroups?cursor=second` },
    });

    await expect(adapter.listBetaGroups('app-1')).rejects.toThrow(
      'pagination changed collection identity'
    );
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});
