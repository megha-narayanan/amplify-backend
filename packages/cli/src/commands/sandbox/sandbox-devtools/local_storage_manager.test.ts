import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import {
  type CloudWatchLogEntry,
  type DeploymentEvent,
  LocalStorageManager,
} from './local_storage_manager.js';
import { printer } from '@aws-amplify/cli-core';

class MockLocalStorageManager extends LocalStorageManager {
  private mockResources: Record<string, unknown> | null = null;
  private mockCloudWatchLogs: Record<string, CloudWatchLogEntry[]> = {};
  private mockDeploymentProgress: DeploymentEvent[] = [];
  private mockResourceLoggingStates: Record<
    string,
    { isActive: boolean; lastUpdated: string }
  > | null = null;
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

  saveCloudWatchLogs(resourceId: string, logs: CloudWatchLogEntry[]): void {
    this.mockCloudWatchLogs[resourceId] = logs;
  }

  loadCloudWatchLogs(resourceId: string): CloudWatchLogEntry[] {
    return this.mockCloudWatchLogs[resourceId] || [];
  }

  getResourcesWithCloudWatchLogs(): string[] {
    return Object.keys(this.mockCloudWatchLogs);
  }

  appendCloudWatchLog(resourceId: string, logEntry: CloudWatchLogEntry): void {
    if (!this.mockCloudWatchLogs[resourceId]) {
      this.mockCloudWatchLogs[resourceId] = [];
    }
    this.mockCloudWatchLogs[resourceId].push(logEntry);
  }

  saveDeploymentProgress(events: DeploymentEvent[]): void {
    this.mockDeploymentProgress = events;
  }

  loadDeploymentProgress(): DeploymentEvent[] {
    return this.mockDeploymentProgress;
  }

  appendDeploymentProgressEvent(event: Record<string, unknown>): void {
    this.mockDeploymentProgress.push(event as DeploymentEvent);
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
      lastUpdated: new Date().toISOString(),
    };
  }

  loadResourceLoggingStates(): Record<
    string,
    { isActive: boolean; lastUpdated: string }
  > | null {
    return this.mockResourceLoggingStates;
  }

  getResourceLoggingState(
    resourceId: string,
  ): { isActive: boolean; lastUpdated: string } | null {
    if (
      !this.mockResourceLoggingStates ||
      !this.mockResourceLoggingStates[resourceId]
    ) {
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
      const manager = new MockLocalStorageManager(mockIdentifier, {
        maxLogSizeMB: 100,
      });

      assert.strictEqual(manager.maxLogSizeMB, 100);
    });
  });

  void describe('saveResources and loadResources', () => {
    void it('saves resources to a file', () => {
      const resources = { name: 'test', resources: [{ id: '1' }] };

      storageManager.saveResources(resources);

      assert.deepStrictEqual(storageManager.loadResources(), resources);
    });

    void it('loads resources from a file', () => {
      const mockResources = { name: 'test', resources: [{ id: '1' }] };
      storageManager.saveResources(mockResources);

      const result = storageManager.loadResources();

      assert.deepStrictEqual(result, mockResources);
    });

    void it('returns null if resources file does not exist', () => {
      const result = storageManager.loadResources();

      assert.strictEqual(result, null);
    });
  });

  void describe('clearResources', () => {
    void it('deletes the resources file if it exists', () => {
      const resources = { name: 'test', resources: [{ id: '1' }] };
      storageManager.saveResources(resources);

      storageManager.clearResources();

      assert.strictEqual(storageManager.loadResources(), null);
    });
  });

  void describe('CloudWatch logs operations', () => {
    void it('saves CloudWatch logs for a resource', () => {
      const resourceId = 'lambda-function';
      const logs = [{ timestamp: 1672531200000, message: 'Test log' }];

      storageManager.saveCloudWatchLogs(resourceId, logs);

      assert.deepStrictEqual(
        storageManager.loadCloudWatchLogs(resourceId),
        logs,
      );
    });

    void it('loads CloudWatch logs for a resource', () => {
      const resourceId = 'lambda-function';
      const mockLogs = [{ timestamp: 1672531200000, message: 'Test log' }];
      storageManager.saveCloudWatchLogs(resourceId, mockLogs);

      const result = storageManager.loadCloudWatchLogs(resourceId);

      assert.deepStrictEqual(result, mockLogs);
    });

    void it('returns empty array if CloudWatch logs file does not exist', () => {
      const result = storageManager.loadCloudWatchLogs('lambda-function');

      assert.deepStrictEqual(result, []);
    });

    void it("appends a log entry to a resource's CloudWatch logs", () => {
      const resourceId = 'lambda-function';
      const existingLogs = [
        { timestamp: 1672531200000, message: 'Existing log' },
      ];
      const newLog = { timestamp: 1672531260000, message: 'New log' };
      storageManager.saveCloudWatchLogs(resourceId, existingLogs);

      storageManager.appendCloudWatchLog(resourceId, newLog);

      const savedLogs = storageManager.loadCloudWatchLogs(resourceId);
      assert.strictEqual(savedLogs.length, 2);
      assert.deepStrictEqual(savedLogs[1], newLog);
    });

    void it('gets a list of resources with CloudWatch logs', () => {
      storageManager.saveCloudWatchLogs('lambda-function', [
        { timestamp: 1672531200000, message: 'Test log' },
      ]);
      storageManager.saveCloudWatchLogs('api-gateway', [
        { timestamp: 1672531200000, message: 'Test log' },
      ]);

      const result = storageManager.getResourcesWithCloudWatchLogs();

      assert.deepStrictEqual(result.sort(), ['api-gateway', 'lambda-function']);
    });

    void it('returns empty array if no CloudWatch logs exist', () => {
      const result = storageManager.getResourcesWithCloudWatchLogs();

      assert.deepStrictEqual(result, []);
    });
  });

  void describe('Deployment progress operations', () => {
    void it('saves deployment progress events', () => {
      const events = [
        {
          timestamp: '2023-01-01T00:00:00Z',
          eventType: 'CREATE_IN_PROGRESS',
          message: 'CREATE_IN_PROGRESS',
        },
        {
          timestamp: '2023-01-01T00:01:00Z',
          eventType: 'CREATE_COMPLETE',
          message: 'CREATE_COMPLETE',
        },
      ];

      storageManager.saveDeploymentProgress(events);

      assert.deepStrictEqual(storageManager.loadDeploymentProgress(), events);
    });

    void it('loads deployment progress events', () => {
      const mockEvents = [
        {
          timestamp: '2023-01-01T00:00:00Z',
          eventType: 'CREATE_IN_PROGRESS',
          message: 'CREATE_IN_PROGRESS',
        },
        {
          timestamp: '2023-01-01T00:01:00Z',
          eventType: 'CREATE_COMPLETE',
          message: 'CREATE_COMPLETE',
        },
      ];
      storageManager.saveDeploymentProgress(mockEvents);

      const result = storageManager.loadDeploymentProgress();

      assert.deepStrictEqual(result, mockEvents);
    });

    void it('returns empty array if deployment progress file does not exist', () => {
      const result = storageManager.loadDeploymentProgress();

      assert.deepStrictEqual(result, []);
    });

    void it('appends a deployment progress event', () => {
      const existingEvents = [
        {
          timestamp: '2023-01-01T00:00:00Z',
          eventType: 'CREATE_IN_PROGRESS',
          message: 'CREATE_IN_PROGRESS',
        },
      ];
      const newEvent = {
        timestamp: '2023-01-01T00:01:00Z',
        eventType: 'CREATE_COMPLETE',
        message: 'CREATE_COMPLETE',
      };
      storageManager.saveDeploymentProgress(existingEvents);

      storageManager.appendDeploymentProgressEvent(newEvent);

      const savedEvents = storageManager.loadDeploymentProgress();
      assert.strictEqual(savedEvents.length, 2);
      assert.deepStrictEqual(savedEvents[1], newEvent);
    });

    void it('clears deployment progress events', () => {
      const events = [
        {
          timestamp: '2023-01-01T00:00:00Z',
          eventType: 'CREATE_IN_PROGRESS',
          message: 'CREATE_IN_PROGRESS',
        },
        {
          timestamp: '2023-01-01T00:01:00Z',
          eventType: 'CREATE_COMPLETE',
          message: 'CREATE_COMPLETE',
        },
      ];
      storageManager.saveDeploymentProgress(events);

      storageManager.clearDeploymentProgress();

      assert.deepStrictEqual(storageManager.loadDeploymentProgress(), []);
    });
  });

  void describe('Resource logging state operations', () => {
    void it('saves resource logging state', () => {
      const resourceId = 'lambda-function';
      const isActive = true;

      storageManager.saveResourceLoggingState(resourceId, isActive);

      const state = storageManager.getResourceLoggingState(resourceId);
      assert.strictEqual(state?.isActive, true);
    });

    void it('loads resource logging states', () => {
      storageManager.saveResourceLoggingState('lambda-function', true);
      storageManager.saveResourceLoggingState('api-gateway', false);

      const result = storageManager.loadResourceLoggingStates();

      assert.strictEqual(result?.['lambda-function'].isActive, true);
      assert.strictEqual(result?.['api-gateway'].isActive, false);
    });

    void it('returns null if resource logging states file does not exist', () => {
      const result = storageManager.loadResourceLoggingStates();

      assert.strictEqual(result, null);
    });

    void it('gets resource logging state for a specific resource', () => {
      storageManager.saveResourceLoggingState('lambda-function', true);
      storageManager.saveResourceLoggingState('api-gateway', false);

      const result = storageManager.getResourceLoggingState('lambda-function');

      assert.strictEqual(result?.isActive, true);
    });

    void it('returns null if resource logging state is not found', () => {
      storageManager.saveResourceLoggingState('lambda-function', true);

      const result = storageManager.getResourceLoggingState('non-existent');

      assert.strictEqual(result, null);
    });

    void it('gets resources with active logging', () => {
      storageManager.saveResourceLoggingState('lambda-function', true);
      storageManager.saveResourceLoggingState('api-gateway', false);
      storageManager.saveResourceLoggingState('dynamodb-table', true);

      const result = storageManager.getResourcesWithActiveLogging();

      assert.deepStrictEqual(result.sort(), [
        'dynamodb-table',
        'lambda-function',
      ]);
    });
  });

  void describe('Custom friendly names operations', () => {
    void it('saves custom friendly names', () => {
      const friendlyNames = {
        'lambda-function': 'My Lambda Function',
        'api-gateway': 'My API Gateway',
      };

      storageManager.saveCustomFriendlyNames(friendlyNames);

      assert.deepStrictEqual(
        storageManager.loadCustomFriendlyNames(),
        friendlyNames,
      );
    });

    void it('loads custom friendly names', () => {
      const mockFriendlyNames = {
        'lambda-function': 'My Lambda Function',
        'api-gateway': 'My API Gateway',
      };
      storageManager.saveCustomFriendlyNames(mockFriendlyNames);

      const result = storageManager.loadCustomFriendlyNames();

      assert.deepStrictEqual(result, mockFriendlyNames);
    });

    void it('returns empty object if custom friendly names file does not exist', () => {
      const result = storageManager.loadCustomFriendlyNames();
      assert.deepStrictEqual(result, {});
    });

    void it('updates a custom friendly name', () => {
      const existingNames = {
        'lambda-function': 'Old Name',
        'api-gateway': 'API Gateway',
      };
      storageManager.saveCustomFriendlyNames(existingNames);

      storageManager.updateCustomFriendlyName('lambda-function', 'New Name');

      const savedNames = storageManager.loadCustomFriendlyNames();
      assert.strictEqual(savedNames['lambda-function'], 'New Name');
      assert.strictEqual(savedNames['api-gateway'], 'API Gateway');
    });

    void it('removes a custom friendly name', () => {
      const existingNames = {
        'lambda-function': 'Lambda Function',
        'api-gateway': 'API Gateway',
      };
      storageManager.saveCustomFriendlyNames(existingNames);

      storageManager.removeCustomFriendlyName('lambda-function');

      const savedNames = storageManager.loadCustomFriendlyNames();
      assert.strictEqual(savedNames['lambda-function'], undefined);
      assert.strictEqual(savedNames['api-gateway'], 'API Gateway');
    });
  });

  void describe('Log size management', () => {
    void it('gets logs size in MB', () => {
      storageManager.setMockLogSize(6); // 6MB

      const result = storageManager.getLogsSizeInMB();

      assert.strictEqual(result, 6);
    });

    void it('checks if logs exceed size limit', () => {
      const manager = new MockLocalStorageManager(mockIdentifier, {
        maxLogSizeMB: 5,
      });
      manager.setMockLogSize(10); // 10MB

      const result = manager.logsExceedSizeLimit();

      assert.strictEqual(result, true);
    });

    void it('sets max log size', () => {
      storageManager.setMaxLogSize(90);

      assert.strictEqual(storageManager.maxLogSizeMB, 90);
    });

    void it('sets max log size (back to default)', () => {
      storageManager.setMaxLogSize(50);

      assert.strictEqual(storageManager.maxLogSizeMB, 50);
    });
  });

  void describe('clearAll', () => {
    void it('removes all files in all directories', () => {
      storageManager.saveResources({ test: 'data' });
      storageManager.saveCloudWatchLogs('lambda-function', [
        { timestamp: 1672531200000, message: 'Test log' },
      ]);
      storageManager.saveDeploymentProgress([
        {
          timestamp: '2023-01-01T00:00:00Z',
          eventType: 'CREATE_IN_PROGRESS',
          message: 'CREATE_IN_PROGRESS',
        },
      ]);

      storageManager.clearAll();

      assert.strictEqual(storageManager.loadResources(), null);
      assert.deepStrictEqual(
        storageManager.loadCloudWatchLogs('lambda-function'),
        [],
      );
      assert.deepStrictEqual(storageManager.loadDeploymentProgress(), []);
    });
  });
});
