import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { LocalStorageManager } from './local_storage_manager.js';
import { LogLevel, printer } from '@aws-amplify/cli-core';

class MockLocalStorageManager extends LocalStorageManager {
  private mockResources: Record<string, unknown> | null = null;
  private mockCloudWatchLogs: Record<string, any[]> = {};
  private mockDeploymentProgress: any[] = [];
  private mockResourceLoggingStates: Record<string, { isActive: boolean, lastUpdated: string }> | null = null;
  private mockCustomFriendlyNames: Record<string, string> = {};
  private mockLogSize = 0;

  constructor(identifier?: string, options?: { maxLogSizeMB?: number }) {
    super(identifier, options);
  }

  saveResources(resources: Record<string, unknown>): void {
    this.mockResources = resources;
  }

  loadResources(): Record<string, unknown> | null {
    return this.mockResources;
  }

  clearResources(): void {
    this.mockResources = null;
  }

  saveCloudWatchLogs(resourceId: string, logs: any[]): void {
    this.mockCloudWatchLogs[resourceId] = logs;
  }

  loadCloudWatchLogs(resourceId: string): any[] {
    return this.mockCloudWatchLogs[resourceId] || [];
  }

  getResourcesWithCloudWatchLogs(): string[] {
    return Object.keys(this.mockCloudWatchLogs);
  }

  appendCloudWatchLog(resourceId: string, logEntry: any): void {
    if (!this.mockCloudWatchLogs[resourceId]) {
      this.mockCloudWatchLogs[resourceId] = [];
    }
    this.mockCloudWatchLogs[resourceId].push(logEntry);
  }

  saveDeploymentProgress(events: any[]): void {
    this.mockDeploymentProgress = events;
  }

  loadDeploymentProgress(): any[] {
    return this.mockDeploymentProgress;
  }

  appendDeploymentProgressEvent(event: Record<string, unknown>): void {
    this.mockDeploymentProgress.push(event);
  }

  clearDeploymentProgress(): void {
    this.mockDeploymentProgress = [];
  }

  saveResourceLoggingState(resourceId: string, isActive: boolean): void {
    if (!this.mockResourceLoggingStates) {
      this.mockResourceLoggingStates = {};
    }
    this.mockResourceLoggingStates[resourceId] = {
      isActive,
      lastUpdated: new Date().toISOString()
    };
  }

  loadResourceLoggingStates(): Record<string, { isActive: boolean, lastUpdated: string }> | null {
    return this.mockResourceLoggingStates;
  }

  getResourceLoggingState(resourceId: string): { isActive: boolean, lastUpdated: string } | null {
    if (!this.mockResourceLoggingStates || !this.mockResourceLoggingStates[resourceId]) {
      return null;
    }
    return this.mockResourceLoggingStates[resourceId];
  }

  getResourcesWithActiveLogging(): string[] {
    if (!this.mockResourceLoggingStates) {
      return [];
    }
    return Object.entries(this.mockResourceLoggingStates)
      .filter(([, state]) => state.isActive)
      .map(([resourceId]) => resourceId);
  }

  saveCustomFriendlyNames(friendlyNames: Record<string, string>): void {
    this.mockCustomFriendlyNames = friendlyNames;
  }

  loadCustomFriendlyNames(): Record<string, string> {
    return this.mockCustomFriendlyNames;
  }

  updateCustomFriendlyName(resourceId: string, friendlyName: string): void {
    this.mockCustomFriendlyNames[resourceId] = friendlyName;
  }

  removeCustomFriendlyName(resourceId: string): void {
    delete this.mockCustomFriendlyNames[resourceId];
  }

  getLogsSizeInMB(): number {
    return this.mockLogSize;
  }

  setMockLogSize(sizeInMB: number): void {
    this.mockLogSize = sizeInMB;
  }

  clearAll(): void {
    this.mockResources = null;
    this.mockCloudWatchLogs = {};
    this.mockDeploymentProgress = [];
    this.mockResourceLoggingStates = null;
    this.mockCustomFriendlyNames = {};
    this.mockLogSize = 0;
  }
}

void describe('LocalStorageManager', () => {
  const mockIdentifier = 'test-backend';
  let storageManager: MockLocalStorageManager;
  
  // Reset mocks before each test
  beforeEach(() => {
    mock.reset();
    
    // Mock printer.log to avoid console output during tests
    mock.method(printer, 'log').mock.mockImplementation(() => {});
    
    // Create storage manager instance
    storageManager = new MockLocalStorageManager(mockIdentifier);
  });
  
  afterEach(() => {
    mock.reset();
  });
  
  void describe('constructor', () => {
    void it('uses default max log size if not provided', () => {
      // Execute
      const manager = new MockLocalStorageManager(mockIdentifier);
      
      // Verify
      assert.strictEqual(manager.maxLogSizeMB, 50); // Default is 50MB
    });
    
    void it('uses custom max log size if provided', () => {
      // Execute
      const manager = new MockLocalStorageManager(mockIdentifier, { maxLogSizeMB: 100 });
      
      // Verify
      assert.strictEqual(manager.maxLogSizeMB, 100);
    });
  });
  
  void describe('saveResources and loadResources', () => {
    void it('saves resources to a file', () => {
      // Setup
      const resources = { name: 'test', resources: [{ id: '1' }] };
      
      // Execute
      storageManager.saveResources(resources);
      
      // Verify
      assert.deepStrictEqual(storageManager.loadResources(), resources);
    });
    
    void it('loads resources from a file', () => {
      // Setup
      const mockResources = { name: 'test', resources: [{ id: '1' }] };
      storageManager.saveResources(mockResources);
      
      // Execute
      const result = storageManager.loadResources();
      
      // Verify
      assert.deepStrictEqual(result, mockResources);
    });
    
    void it('returns null if resources file does not exist', () => {
      // Setup - don't save any resources
      
      // Execute
      const result = storageManager.loadResources();
      
      // Verify
      assert.strictEqual(result, null);
    });
  });
  
  void describe('clearResources', () => {
    void it('deletes the resources file if it exists', () => {
      // Setup
      const resources = { name: 'test', resources: [{ id: '1' }] };
      storageManager.saveResources(resources);
      
      // Execute
      storageManager.clearResources();
      
      // Verify
      assert.strictEqual(storageManager.loadResources(), null);
    });
  });
  
  void describe('CloudWatch logs operations', () => {
    void it('saves CloudWatch logs for a resource', () => {
      // Setup
      const resourceId = 'lambda-function';
      const logs = [{ timestamp: '2023-01-01T00:00:00Z', message: 'Test log' }];
      
      // Execute
      storageManager.saveCloudWatchLogs(resourceId, logs);
      
      // Verify
      assert.deepStrictEqual(storageManager.loadCloudWatchLogs(resourceId), logs);
    });
    
    void it('loads CloudWatch logs for a resource', () => {
      // Setup
      const resourceId = 'lambda-function';
      const mockLogs = [{ timestamp: '2023-01-01T00:00:00Z', message: 'Test log' }];
      storageManager.saveCloudWatchLogs(resourceId, mockLogs);
      
      // Execute
      const result = storageManager.loadCloudWatchLogs(resourceId);
      
      // Verify
      assert.deepStrictEqual(result, mockLogs);
    });
    
    void it('returns empty array if CloudWatch logs file does not exist', () => {
      // Setup - don't save any logs
      
      // Execute
      const result = storageManager.loadCloudWatchLogs('lambda-function');
      
      // Verify
      assert.deepStrictEqual(result, []);
    });
    
    void it('appends a log entry to a resource\'s CloudWatch logs', () => {
      // Setup
      const resourceId = 'lambda-function';
      const existingLogs = [{ timestamp: '2023-01-01T00:00:00Z', message: 'Existing log' }];
      const newLog = { timestamp: '2023-01-01T00:01:00Z', message: 'New log' };
      storageManager.saveCloudWatchLogs(resourceId, existingLogs);
      
      // Execute
      storageManager.appendCloudWatchLog(resourceId, newLog);
      
      // Verify
      const savedLogs = storageManager.loadCloudWatchLogs(resourceId);
      assert.strictEqual(savedLogs.length, 2);
      assert.deepStrictEqual(savedLogs[1], newLog);
    });
    
    void it('gets a list of resources with CloudWatch logs', () => {
      // Setup
      storageManager.saveCloudWatchLogs('lambda-function', [{ timestamp: '2023-01-01T00:00:00Z', message: 'Test log' }]);
      storageManager.saveCloudWatchLogs('api-gateway', [{ timestamp: '2023-01-01T00:00:00Z', message: 'Test log' }]);
      
      // Execute
      const result = storageManager.getResourcesWithCloudWatchLogs();
      
      // Verify
      assert.deepStrictEqual(result.sort(), ['api-gateway', 'lambda-function']);
    });
    
    void it('returns empty array if no CloudWatch logs exist', () => {
      // Setup - don't save any logs
      
      // Execute
      const result = storageManager.getResourcesWithCloudWatchLogs();
      
      // Verify
      assert.deepStrictEqual(result, []);
    });
  });
  
  void describe('Deployment progress operations', () => {
    void it('saves deployment progress events', () => {
      // Setup
      const events = [
        { timestamp: '2023-01-01T00:00:00Z', message: 'CREATE_IN_PROGRESS' },
        { timestamp: '2023-01-01T00:01:00Z', message: 'CREATE_COMPLETE' }
      ];
      
      // Execute
      storageManager.saveDeploymentProgress(events);
      
      // Verify
      assert.deepStrictEqual(storageManager.loadDeploymentProgress(), events);
    });
    
    void it('loads deployment progress events', () => {
      // Setup
      const mockEvents = [
        { timestamp: '2023-01-01T00:00:00Z', message: 'CREATE_IN_PROGRESS' },
        { timestamp: '2023-01-01T00:01:00Z', message: 'CREATE_COMPLETE' }
      ];
      storageManager.saveDeploymentProgress(mockEvents);
      
      // Execute
      const result = storageManager.loadDeploymentProgress();
      
      // Verify
      assert.deepStrictEqual(result, mockEvents);
    });
    
    void it('returns empty array if deployment progress file does not exist', () => {
      // Setup - don't save any events
      
      // Execute
      const result = storageManager.loadDeploymentProgress();
      
      // Verify
      assert.deepStrictEqual(result, []);
    });
    
    void it('appends a deployment progress event', () => {
      // Setup
      const existingEvents = [{ timestamp: '2023-01-01T00:00:00Z', message: 'CREATE_IN_PROGRESS' }];
      const newEvent = { timestamp: '2023-01-01T00:01:00Z', message: 'CREATE_COMPLETE' };
      storageManager.saveDeploymentProgress(existingEvents);
      
      // Execute
      storageManager.appendDeploymentProgressEvent(newEvent);
      
      // Verify
      const savedEvents = storageManager.loadDeploymentProgress();
      assert.strictEqual(savedEvents.length, 2);
      assert.deepStrictEqual(savedEvents[1], newEvent);
    });
    
    void it('clears deployment progress events', () => {
      // Setup
      const events = [
        { timestamp: '2023-01-01T00:00:00Z', message: 'CREATE_IN_PROGRESS' },
        { timestamp: '2023-01-01T00:01:00Z', message: 'CREATE_COMPLETE' }
      ];
      storageManager.saveDeploymentProgress(events);
      
      // Execute
      storageManager.clearDeploymentProgress();
      
      // Verify
      assert.deepStrictEqual(storageManager.loadDeploymentProgress(), []);
    });
  });
  
  void describe('Resource logging state operations', () => {
    void it('saves resource logging state', () => {
      // Setup
      const resourceId = 'lambda-function';
      const isActive = true;
      
      // Execute
      storageManager.saveResourceLoggingState(resourceId, isActive);
      
      // Verify
      const state = storageManager.getResourceLoggingState(resourceId);
      assert.strictEqual(state?.isActive, true);
    });
    
    void it('loads resource logging states', () => {
      // Setup
      storageManager.saveResourceLoggingState('lambda-function', true);
      storageManager.saveResourceLoggingState('api-gateway', false);
      
      // Execute
      const result = storageManager.loadResourceLoggingStates();
      
      // Verify
      assert.strictEqual(result?.['lambda-function'].isActive, true);
      assert.strictEqual(result?.['api-gateway'].isActive, false);
    });
    
    void it('returns null if resource logging states file does not exist', () => {
      // Setup - don't save any states
      
      // Execute
      const result = storageManager.loadResourceLoggingStates();
      
      // Verify
      assert.strictEqual(result, null);
    });
    
    void it('gets resource logging state for a specific resource', () => {
      // Setup
      storageManager.saveResourceLoggingState('lambda-function', true);
      storageManager.saveResourceLoggingState('api-gateway', false);
      
      // Execute
      const result = storageManager.getResourceLoggingState('lambda-function');
      
      // Verify
      assert.strictEqual(result?.isActive, true);
    });
    
    void it('returns null if resource logging state is not found', () => {
      // Setup
      storageManager.saveResourceLoggingState('lambda-function', true);
      
      // Execute
      const result = storageManager.getResourceLoggingState('non-existent');
      
      // Verify
      assert.strictEqual(result, null);
    });
    
    void it('gets resources with active logging', () => {
      // Setup
      storageManager.saveResourceLoggingState('lambda-function', true);
      storageManager.saveResourceLoggingState('api-gateway', false);
      storageManager.saveResourceLoggingState('dynamodb-table', true);
      
      // Execute
      const result = storageManager.getResourcesWithActiveLogging();
      
      // Verify
      assert.deepStrictEqual(result.sort(), ['dynamodb-table', 'lambda-function']);
    });
  });
  
  void describe('Custom friendly names operations', () => {
    void it('saves custom friendly names', () => {
      // Setup
      const friendlyNames = {
        'lambda-function': 'My Lambda Function',
        'api-gateway': 'My API Gateway'
      };
      
      // Execute
      storageManager.saveCustomFriendlyNames(friendlyNames);
      
      // Verify
      assert.deepStrictEqual(storageManager.loadCustomFriendlyNames(), friendlyNames);
    });
    
    void it('loads custom friendly names', () => {
      // Setup
      const mockFriendlyNames = {
        'lambda-function': 'My Lambda Function',
        'api-gateway': 'My API Gateway'
      };
      storageManager.saveCustomFriendlyNames(mockFriendlyNames);
      
      // Execute
      const result = storageManager.loadCustomFriendlyNames();
      
      // Verify
      assert.deepStrictEqual(result, mockFriendlyNames);
    });
    
    void it('returns empty object if custom friendly names file does not exist', () => {
      // Setup - don't save any friendly names
      
      // Execute
      const result = storageManager.loadCustomFriendlyNames();
      
      // Verify
      assert.deepStrictEqual(result, {});
    });
    
    void it('updates a custom friendly name', () => {
      // Setup
      const existingNames = {
        'lambda-function': 'Old Name',
        'api-gateway': 'API Gateway'
      };
      storageManager.saveCustomFriendlyNames(existingNames);
      
      // Execute
      storageManager.updateCustomFriendlyName('lambda-function', 'New Name');
      
      // Verify
      const savedNames = storageManager.loadCustomFriendlyNames();
      assert.strictEqual(savedNames['lambda-function'], 'New Name');
      assert.strictEqual(savedNames['api-gateway'], 'API Gateway');
    });
    
    void it('removes a custom friendly name', () => {
      // Setup
      const existingNames = {
        'lambda-function': 'Lambda Function',
        'api-gateway': 'API Gateway'
      };
      storageManager.saveCustomFriendlyNames(existingNames);
      
      // Execute
      storageManager.removeCustomFriendlyName('lambda-function');
      
      // Verify
      const savedNames = storageManager.loadCustomFriendlyNames();
      assert.strictEqual(savedNames['lambda-function'], undefined);
      assert.strictEqual(savedNames['api-gateway'], 'API Gateway');
    });
  });
  
  void describe('Log size management', () => {
    void it('gets logs size in MB', () => {
      // Setup
      storageManager.setMockLogSize(6); // 6MB
      
      // Execute
      const result = storageManager.getLogsSizeInMB();
      
      // Verify
      assert.strictEqual(result, 6);
    });
    
    void it('checks if logs exceed size limit', () => {
      // Setup
      const manager = new MockLocalStorageManager(mockIdentifier, { maxLogSizeMB: 5 });
      manager.setMockLogSize(10); // 10MB
      
      // Execute
      const result = manager.logsExceedSizeLimit();
      
      // Verify
      assert.strictEqual(result, true);
    });
    
    void it('sets max log size', () => {
      // Execute
      storageManager.setMaxLogSize(100);
      
      // Verify
      assert.strictEqual(storageManager.maxLogSizeMB, 100);
    });
  });
  
  void describe('clearAll', () => {
    void it('removes all files in all directories', () => {
      // Setup
      storageManager.saveResources({ test: 'data' });
      storageManager.saveCloudWatchLogs('lambda-function', [{ timestamp: '2023-01-01T00:00:00Z', message: 'Test log' }]);
      storageManager.saveDeploymentProgress([{ timestamp: '2023-01-01T00:00:00Z', message: 'CREATE_IN_PROGRESS' }]);
      
      // Execute
      storageManager.clearAll();
      
      // Verify
      assert.strictEqual(storageManager.loadResources(), null);
      assert.deepStrictEqual(storageManager.loadCloudWatchLogs('lambda-function'), []);
      assert.deepStrictEqual(storageManager.loadDeploymentProgress(), []);
    });
  });
});
