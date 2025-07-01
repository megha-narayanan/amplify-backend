import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { ResourceService } from './resource_service.js';
import type { LocalStorageManager } from '../local_storage_manager.js';

void describe('ResourceService', () => {
  let resourceService: ResourceService;
  let mockStorageManager: LocalStorageManager;
  let mockBackendClient: { getBackendMetadata: ReturnType<typeof mock.fn> };
  let mockLoadResources: ReturnType<typeof mock.fn>;
  let mockSaveResources: ReturnType<typeof mock.fn>;
  const mockBackendId = { name: 'test-backend' };

  beforeEach(() => {
    mock.reset();

    mockLoadResources = mock.fn();
    mockSaveResources = mock.fn();

    mockStorageManager = {
      loadResources: mockLoadResources,
      saveResources: mockSaveResources,
    } as unknown as LocalStorageManager;

    const getSandboxState = async () => 'running';

    const mockGetBackendMetadata = mock.fn();

    resourceService = new ResourceService(
      mockStorageManager,
      mockBackendId.name,
      getSandboxState,
      'amplify-backend', // Add namespace parameter
    );

    (
      resourceService as unknown as { backendClient: typeof mockBackendClient }
    ).backendClient = {
      getBackendMetadata: mockGetBackendMetadata,
    };

    mockBackendClient = (
      resourceService as unknown as { backendClient: typeof mockBackendClient }
    ).backendClient;

    (resourceService as unknown as { getRegion: () => string }).getRegion =
      () => 'us-east-1';
  });

  void describe('getDeployedBackendResources', () => {
    void it('returns saved resources if available', async () => {
      const savedResources = {
        name: 'test-backend',
        resources: [{ logicalResourceId: 'resource1' }],
      };

      mockLoadResources.mock.mockImplementation(() => savedResources);

      const result = await resourceService.getDeployedBackendResources();

      assert.strictEqual(result.name, 'test-backend');
      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.resources[0].logicalResourceId, 'resource1');
      assert.strictEqual(mockSaveResources.mock.callCount(), 0);
    });

    void it('fetches backend metadata when no saved resources exist', async () => {
      mockLoadResources.mock.mockImplementation(() => null);

      const mockResources = [
        {
          logicalResourceId: 'amplifyFunction123ABC',
          physicalResourceId: 'my-function-123',
          resourceType: 'AWS::Lambda::Function',
          resourceStatus: 'CREATE_COMPLETE',
          metadata: { constructPath: 'MyStack/MyFunction/Resource' },
        },
      ];

      const mockMetadata = {
        name: 'test-backend',
        resources: mockResources,
      };

      mockBackendClient.getBackendMetadata.mock.mockImplementation(() =>
        Promise.resolve(mockMetadata),
      );

      const result = await resourceService.getDeployedBackendResources();

      assert.strictEqual(result.name, 'test-backend');
      assert.strictEqual(result.resources.length, 1);
      assert.strictEqual(
        result.resources[0].friendlyName,
        'MyStack/MyFunction/Resource',
      );
      assert.strictEqual(mockSaveResources.mock.callCount(), 1);
    });

    void it('handles deployment in progress error', async () => {
      mockLoadResources.mock.mockImplementation(() => null);
      mockBackendClient.getBackendMetadata.mock.mockImplementation(() => {
        throw new Error('deployment is in progress');
      });

      const result = await resourceService.getDeployedBackendResources();

      assert.strictEqual(result.status, 'deploying');
      assert.strictEqual(result.resources.length, 0);
      assert.strictEqual(
        result.message,
        'Sandbox deployment is in progress. Resources will update when deployment completes.',
      );
    });

    void it('handles non-existent stack error', async () => {
      mockLoadResources.mock.mockImplementation(() => null);
      mockBackendClient.getBackendMetadata.mock.mockImplementation(() => {
        throw new Error('does not exist');
      });

      const result = await resourceService.getDeployedBackendResources();

      assert.strictEqual(result.status, 'nonexistent');
      assert.strictEqual(result.resources.length, 0);
      assert.strictEqual(
        result.message,
        'No sandbox exists. Please create a sandbox first.',
      );
    });

    void it('throws error for unexpected errors', async () => {
      mockLoadResources.mock.mockImplementation(() => null);
      mockBackendClient.getBackendMetadata.mock.mockImplementation(() => {
        throw new Error('unexpected error');
      });

      await assert.rejects(
        async () => await resourceService.getDeployedBackendResources(),
        (error: Error) => {
          assert.strictEqual(error.message, 'unexpected error');
          return true;
        },
      );
    });
  });
});
