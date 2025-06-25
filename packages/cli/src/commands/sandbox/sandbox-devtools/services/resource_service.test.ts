import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ResourceService } from './resource_service.js';

void describe('ResourceService', () => {
  let resourceService: ResourceService;
  let mockStorageManager: any;
  let mockBackendClient: any;
  const mockBackendId = { name: 'test-backend' };
  
  beforeEach(() => {
    mock.reset();
    
    mockStorageManager = {
      loadResources: mock.fn(),
      saveResources: mock.fn()
    };
    
    const getSandboxState = () => 'running';
    
    const mockGetBackendMetadata = mock.fn();
    
    resourceService = new ResourceService(
      mockStorageManager,
      mockBackendId,
      getSandboxState
    );
    
    (resourceService as any).backendClient = {
      getBackendMetadata: mockGetBackendMetadata
    };
    
    mockBackendClient = (resourceService as any).backendClient;
    
    (resourceService as any).getRegion = () => 'us-east-1';
  });
  
  void describe('getDeployedBackendResources', () => {
    void it('returns saved resources if available', async () => {
      const savedResources = {
        name: 'test-backend',
        resources: [{ logicalResourceId: 'resource1' }],
      };
      
      mockStorageManager.loadResources.mock.mockImplementation(() => savedResources);
      
      // Execute
      const result = await resourceService.getDeployedBackendResources();
      
      // Verify
      assert.strictEqual(result.name, 'test-backend');
      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.resources[0].logicalResourceId, 'resource1');
      assert.strictEqual(mockStorageManager.saveResources.mock.callCount(), 0);
    });
    
    void it('fetches backend metadata when no saved resources exist', async () => {
      // Setup
      mockStorageManager.loadResources.mock.mockImplementation(() => null);
      
      const mockResources = [
        {
          logicalResourceId: 'amplifyFunction123ABC',
          physicalResourceId: 'my-function-123',
          resourceType: 'AWS::Lambda::Function',
          resourceStatus: 'CREATE_COMPLETE',
          metadata: { constructPath: 'MyStack/MyFunction/Resource' }
        }
      ];
      
      const mockMetadata = {
        name: 'test-backend',
        resources: mockResources
      };
      
      mockBackendClient.getBackendMetadata.mock.mockImplementation(() => Promise.resolve(mockMetadata));
      
      const result = await resourceService.getDeployedBackendResources();
      
      assert.strictEqual(result.name, 'test-backend');
      assert.strictEqual(result.resources.length, 1);
      assert.strictEqual(result.resources[0].friendlyName, 'MyStack/MyFunction/Resource');
      assert.strictEqual(mockStorageManager.saveResources.mock.callCount(), 1);
    });
    
    void it('handles deployment in progress error', async () => {
      mockStorageManager.loadResources.mock.mockImplementation(() => null);
      mockBackendClient.getBackendMetadata.mock.mockImplementation(() => {
        throw new Error('deployment is in progress');
      });
      
      const result = await resourceService.getDeployedBackendResources();
      
      assert.strictEqual(result.status, 'deploying');
      assert.strictEqual(result.resources.length, 0);
      assert.strictEqual(
        result.message, 
        'Sandbox deployment is in progress. Resources will update when deployment completes.'
      );
    });
    
    void it('handles non-existent stack error', async () => {
      // Setup
      mockStorageManager.loadResources.mock.mockImplementation(() => null);
      mockBackendClient.getBackendMetadata.mock.mockImplementation(() => {
        throw new Error('does not exist');
      });
      
      // Execute
      const result = await resourceService.getDeployedBackendResources();
      
      // Verify
      assert.strictEqual(result.status, 'nonexistent');
      assert.strictEqual(result.resources.length, 0);
      assert.strictEqual(result.message, 'No sandbox exists. Please create a sandbox first.');
    });
    
    void it('throws error for unexpected errors', async () => {
      mockStorageManager.loadResources.mock.mockImplementation(() => null);
      mockBackendClient.getBackendMetadata.mock.mockImplementation(() => {
        throw new Error('unexpected error');
      });
      
      await assert.rejects(
        async () => await resourceService.getDeployedBackendResources(),
        (error: Error) => {
          assert.strictEqual(error.message, 'unexpected error');
          return true;
        }
      );
    });
  });
});
