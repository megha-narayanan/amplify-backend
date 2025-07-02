import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { SocketHandlerService } from './socket_handlers.js';
import { printer } from '@aws-amplify/cli-core';
import type { Server, Socket } from 'socket.io';
// eslint-disable-next-line import/no-extraneous-dependencies
import { LambdaClient } from '@aws-sdk/client-lambda';
// eslint-disable-next-line import/no-extraneous-dependencies
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { LocalStorageManager } from '../local_storage_manager.js';
import type { ResourceService } from './resource_service.js';
import type { ShutdownService } from './shutdown_service.js';
import type { Sandbox } from '@aws-amplify/sandbox';

// Define the return type of mock.fn()
type MockFn = ReturnType<typeof mock.fn>;

// Type for handler functions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventHandler = (...args: any[]) => void | Promise<void>;

// Type for sandbox status data
type SandboxStatusData = {
  status: string;
  identifier: string;
  error?: string;
  timestamp?: string;
};

// Type for lambda test result
type LambdaTestResult = {
  resourceId: string;
  result?: string;
  error?: string;
};

// Type for log settings
type LogSettings = {
  maxLogSizeMB: number;
  currentSizeMB: number;
};

// Type for log stream status
type LogStreamStatus = {
  resourceId: string;
  status: string;
};

// Type for log stream error
type LogStreamError = {
  resourceId: string;
  error: string;
};

// Mock call type with more specific typing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockCall = {
  arguments: readonly unknown[];
};

void describe('SocketHandlerService', () => {
  let service: SocketHandlerService;
  let mockIo: Server;
  let mockSocket: Socket;
  let mockSandbox: Sandbox;
  let mockStorageManager: LocalStorageManager;
  let mockResourceService: ResourceService;
  let mockShutdownService: ShutdownService;

  beforeEach(() => {
    mock.reset();
    mock.method(printer, 'log');

    mockIo = { emit: mock.fn() } as unknown as Server;
    mockSocket = { on: mock.fn(), emit: mock.fn() } as unknown as Socket;
    mockSandbox = { start: mock.fn(), stop: mock.fn(), delete: mock.fn() } as unknown as Sandbox;
    mockStorageManager = {
      loadCloudWatchLogs: mock.fn(() => []),
      saveResourceLoggingState: mock.fn(),
      getResourcesWithActiveLogging: mock.fn(() => []),
      getLogsSizeInMB: mock.fn(() => 10),
      setMaxLogSize: mock.fn(),
      loadCustomFriendlyNames: mock.fn(() => ({})),
      updateCustomFriendlyName: mock.fn(),
      removeCustomFriendlyName: mock.fn(),
      loadDeploymentProgress: mock.fn(() => []),
      loadResources: mock.fn(() => null),
      maxLogSizeMB: 50,
    } as unknown as LocalStorageManager;
    mockResourceService = { getDeployedBackendResources: mock.fn() } as unknown as ResourceService;
    mockShutdownService = { shutdown: mock.fn() } as unknown as ShutdownService;

    service = new SocketHandlerService(
      mockIo, mockSandbox, async () => 'running', { name: 'test-backend' },
      mockShutdownService, {}, mockStorageManager, mockResourceService,
    );
  });
  afterEach(() => {
  // Clean up any active pollers in the service
  if (!service || !service['activeLogPollers']) {
    return;
  }
  for (const interval of service['activeLogPollers'].values()) {
      clearInterval(interval);
    }
    service['activeLogPollers'].clear();
});


  void describe('setupSocketHandlers', () => {
    void it('registers all socket event handlers', () => {
      service.setupSocketHandlers(mockSocket);
      const mockFn = mockSocket.on as unknown as MockFn;
      const eventNames = mockFn.mock.calls.map((call: MockCall) => call.arguments[0] as string);
      
      assert.ok(eventNames.includes('toggleResourceLogging'));
      assert.ok(eventNames.includes('getSandboxStatus'));
      assert.ok(eventNames.includes('testLambdaFunction'));
      assert.ok(eventNames.includes('stopDevTools'));
      
      // Verify all expected handlers are registered
      const expectedHandlers = [
        'toggleResourceLogging',
        'viewResourceLogs',
        'getSavedResourceLogs',
        'getActiveLogStreams',
        'getLogSettings',
        'saveLogSettings',
        'getCustomFriendlyNames',
        'updateCustomFriendlyName',
        'removeCustomFriendlyName',
        'getSandboxStatus',
        'deploymentInProgress',
        'amplifyCloudFormationProgressUpdate',
        'getDeployedBackendResources',
        'getSavedDeploymentProgress',
        'getSavedResources',
        'startSandboxWithOptions',
        'stopSandbox',
        'deleteSandbox',
        'stopDevTools',
        'testLambdaFunction'
      ];
      
      expectedHandlers.forEach(handler => {
        assert.ok(eventNames.includes(handler), `Handler "${handler}" should be registered`);
      });
      
      // Verify the exact number of handlers
      assert.strictEqual(eventNames.length, expectedHandlers.length, 
        `Expected ${expectedHandlers.length} handlers to be registered, got ${eventNames.length}`);
    });
  });

  void describe('handleGetLogSettings', () => {
    void it('emits current log settings', () => {
      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'getLogSettings'
      );
      
      assert.ok(foundCall, 'Could not find getLogSettings handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      void handler();

      // Verify storage manager was called to get log size
      const mockGetLogsSizeFn = mockStorageManager.getLogsSizeInMB as unknown as MockFn;
      assert.strictEqual(mockGetLogsSizeFn.mock.callCount(), 1);

      // Verify socket emit was called with correct event and data
      const mockEmitFn = mockSocket.emit as unknown as MockFn;
      assert.strictEqual(mockEmitFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockEmitFn.mock.calls.length > 0, 'Should have at least one emit call');
      assert.strictEqual(mockEmitFn.mock.calls[0].arguments[0], 'logSettings');
      
      const emittedData = mockEmitFn.mock.calls[0].arguments[1] as LogSettings;
      assert.strictEqual(emittedData.maxLogSizeMB, 50);
      assert.strictEqual(emittedData.currentSizeMB, 10);
    });
  });

  void describe('handleSaveLogSettings', () => {
    void it('updates log settings and broadcasts to all clients', () => {
      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'saveLogSettings'
      );
      
      assert.ok(foundCall, 'Could not find saveLogSettings handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      const newMaxSize = 100;
      void handler({ maxLogSizeMB: newMaxSize });

      // Verify storage manager was called to set max log size
      const mockSetMaxSizeFn = mockStorageManager.setMaxLogSize as unknown as MockFn;
      assert.strictEqual(mockSetMaxSizeFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockSetMaxSizeFn.mock.calls.length > 0, 'Should have at least one setMaxLogSize call');
      assert.strictEqual(
        mockSetMaxSizeFn.mock.calls[0].arguments[0], 
        newMaxSize
      );

      // Verify storage manager was called to get current log size
      const mockGetLogsSizeFn = mockStorageManager.getLogsSizeInMB as unknown as MockFn;
      assert.strictEqual(mockGetLogsSizeFn.mock.callCount(), 1);

      // Verify io.emit was called to broadcast to all clients
      const mockIoEmitFn = mockIo.emit as unknown as MockFn;
      assert.strictEqual(mockIoEmitFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockIoEmitFn.mock.calls.length > 0, 'Should have at least one io.emit call');
      assert.strictEqual(mockIoEmitFn.mock.calls[0].arguments[0], 'logSettings');
      
      const broadcastData = mockIoEmitFn.mock.calls[0].arguments[1] as LogSettings;
      assert.strictEqual(broadcastData.maxLogSizeMB, newMaxSize);
      assert.strictEqual(broadcastData.currentSizeMB, 10);
    });

    void it('ignores invalid settings', () => {
      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'saveLogSettings'
      );
      
      assert.ok(foundCall, 'Could not find saveLogSettings handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      // Call with invalid settings
      void handler(undefined);

      // Verify storage manager was not called
      const mockSetMaxSizeFn = mockStorageManager.setMaxLogSize as unknown as MockFn;
      assert.strictEqual(mockSetMaxSizeFn.mock.callCount(), 0);
      
      const mockGetLogsSizeFn = mockStorageManager.getLogsSizeInMB as unknown as MockFn;
      assert.strictEqual(mockGetLogsSizeFn.mock.callCount(), 0);

      // Verify io.emit was not called
      const mockIoEmitFn = mockIo.emit as unknown as MockFn;
      assert.strictEqual(mockIoEmitFn.mock.callCount(), 0);
    });
  });

  void describe('handleTestLambdaFunction', () => {
    void it('tests lambda function and emits successful result', async () => {
      const expectedResult = { result: 'success' };
      const mockSend = mock.fn(() => Promise.resolve({
        Payload: new TextEncoder().encode(JSON.stringify(expectedResult))
      }));
      mock.method(LambdaClient.prototype, 'send', mockSend);

      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'testLambdaFunction'
      );
      
      assert.ok(foundCall, 'Could not find testLambdaFunction handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      const testInput = {
        resourceId: 'test-resource',
        functionName: 'test-function',
        input: '{"test": true}'
      };
      await handler(testInput);

      // Verify Lambda client was called with correct parameters
      assert.strictEqual(mockSend.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockSend.mock.calls.length > 0, 'Should have at least one send call');
      
      // Verify socket emit was called with correct event and data
      const mockEmitFn = mockSocket.emit as unknown as MockFn;
      assert.strictEqual(mockEmitFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockEmitFn.mock.calls.length > 0, 'Should have at least one emit call');
      assert.strictEqual(mockEmitFn.mock.calls[0].arguments[0], 'lambdaTestResult');
      
      const emittedData = mockEmitFn.mock.calls[0].arguments[1] as LambdaTestResult;
      assert.strictEqual(emittedData.resourceId, 'test-resource');
      assert.ok(emittedData.result);
      assert.ok(!emittedData.error);
    });

    void it('handles lambda function errors and emits error result', async () => {
      const testError = new Error('Lambda execution failed');
      const mockSend = mock.fn(() => Promise.reject(testError));
      mock.method(LambdaClient.prototype, 'send', mockSend);

      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'testLambdaFunction'
      );
      
      assert.ok(foundCall, 'Could not find testLambdaFunction handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      await handler({
        resourceId: 'test-resource',
        functionName: 'test-function',
        input: '{"test": true}'
      });

      // Verify socket emit was called with error information
      const mockEmitFn = mockSocket.emit as unknown as MockFn;
      assert.strictEqual(mockEmitFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockEmitFn.mock.calls.length > 0, 'Should have at least one emit call');
      assert.strictEqual(mockEmitFn.mock.calls[0].arguments[0], 'lambdaTestResult');
      
      const emittedData = mockEmitFn.mock.calls[0].arguments[1] as LambdaTestResult;
      assert.strictEqual(emittedData.resourceId, 'test-resource');
      assert.strictEqual(emittedData.error, 'Error: Lambda execution failed');
      assert.ok(!emittedData.result);
    });
  });

  void describe('handleGetSandboxStatus', () => {
    void it('emits sandbox status', async () => {
      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'getSandboxStatus'
      );
      
      assert.ok(foundCall, 'Could not find getSandboxStatus handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      await handler();

      const mockEmitFn = mockSocket.emit as unknown as MockFn;
      assert.strictEqual(mockEmitFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockEmitFn.mock.calls.length > 0, 'Should have at least one emit call');
      assert.strictEqual(mockEmitFn.mock.calls[0].arguments[0], 'sandboxStatus');
      
      const statusData = mockEmitFn.mock.calls[0].arguments[1] as SandboxStatusData;
      assert.strictEqual(statusData.status, 'running');
      assert.strictEqual(statusData.identifier, 'test-backend');
    });

    void it('handles errors when getting sandbox status', async () => {
      // Setup a sandbox state getter that throws an error
      const errorMessage = 'Failed to get sandbox state';
      const errorService = new SocketHandlerService(
        mockIo, mockSandbox, async () => { throw new Error(errorMessage); }, 
        { name: 'test-backend' }, mockShutdownService, {}, mockStorageManager, mockResourceService
      );

      errorService.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'getSandboxStatus'
      );
      
      assert.ok(foundCall, 'Could not find getSandboxStatus handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      await handler();

      const mockEmitFn = mockSocket.emit as unknown as MockFn;
      assert.strictEqual(mockEmitFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockEmitFn.mock.calls.length > 0, 'Should have at least one emit call');
      assert.strictEqual(mockEmitFn.mock.calls[0].arguments[0], 'sandboxStatus');
      
      const statusData = mockEmitFn.mock.calls[0].arguments[1] as SandboxStatusData;
      assert.strictEqual(statusData.status, 'unknown');
      assert.strictEqual(statusData.identifier, 'test-backend');
      assert.strictEqual(statusData.error, `Error: ${errorMessage}`);
    });
  });

  void describe('handleToggleResourceLogging', () => {
    void it('starts logging for a resource', async () => {
      // Mock CloudWatch Logs client
      const mockDescribeStreamsResponse = {
        logStreams: [{ logStreamName: 'test-stream' }]
      };
      const mockDescribeStreams = mock.fn(() => Promise.resolve(mockDescribeStreamsResponse));
      mock.method(CloudWatchLogsClient.prototype, 'send', mockDescribeStreams);
      process.env.AWS_REGION = 'us-east-1';

      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'toggleResourceLogging'
      );
      
      assert.ok(foundCall, 'Could not find toggleResourceLogging handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      // Start logging
      await handler({
        resourceId: 'test-resource',
        resourceType: 'AWS::Lambda::Function',
        startLogging: true
      });

      // Verify CloudWatch Logs client was called
      assert.strictEqual(mockDescribeStreams.mock.callCount(), 2);
      
      assert.ok(mockDescribeStreams.mock.calls.length > 0, 'Should have at least one send call');
      
      const mockEmitFn = mockSocket.emit as unknown as MockFn;
      const emitCalls = mockEmitFn.mock.calls;

      const startingStatusCall = emitCalls.find(
        (call: MockCall) => call.arguments[0] === 'logStreamStatus' && 
                           call.arguments[1] && 
                           (call.arguments[1] as LogStreamStatus).status === 'starting'
      );
      assert.ok(startingStatusCall, 'Should emit starting status');

      const activeStatusCall = emitCalls.find(
        (call: MockCall) => call.arguments[0] === 'logStreamStatus' && 
                           call.arguments[1] && 
                           (call.arguments[1] as LogStreamStatus).status === 'active'
      );
      assert.ok(activeStatusCall, 'Should emit active status');


      const mockSaveResourceLoggingStateFn = mockStorageManager.saveResourceLoggingState as unknown as MockFn;
      assert.strictEqual(mockSaveResourceLoggingStateFn.mock.callCount(), 1);
      assert.ok(mockSaveResourceLoggingStateFn.mock.calls.length > 0, 'Should have at least one saveResourceLoggingState call');
      assert.strictEqual(
        mockSaveResourceLoggingStateFn.mock.calls[0].arguments[0],
        'test-resource'
      );
      assert.strictEqual(
        mockSaveResourceLoggingStateFn.mock.calls[0].arguments[1],
        true
      );

      // Verify io.emit was called to broadcast status to all clients
      const mockIoEmitFn = mockIo.emit as unknown as MockFn;
      assert.strictEqual(mockIoEmitFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockIoEmitFn.mock.calls.length > 0, 'Should have at least one io.emit call');
      assert.strictEqual(mockIoEmitFn.mock.calls[0].arguments[0], 'logStreamStatus');
      
      const broadcastStatus = mockIoEmitFn.mock.calls[0].arguments[1] as LogStreamStatus;
      assert.strictEqual(broadcastStatus.status, 'active');
    });

    void it('handles errors when log group does not exist', async () => {
      // Mock CloudWatch Logs client to throw ResourceNotFoundException
      const mockError = {
        name: 'ResourceNotFoundException',
        message: 'The specified log group does not exist.'
      };
      const mockDescribeStreams = mock.fn(() => Promise.reject(mockError));
      mock.method(CloudWatchLogsClient.prototype, 'send', mockDescribeStreams);
      process.env.AWS_REGION = 'us-east-1';

      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'toggleResourceLogging'
      );
      
      assert.ok(foundCall, 'Could not find toggleResourceLogging handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      // Start logging
      await handler({
        resourceId: 'test-resource',
        resourceType: 'AWS::Lambda::Function',
        startLogging: true
      });

      // Verify socket emit was called with error
      const mockEmitFn = mockSocket.emit as unknown as MockFn;
      const errorCall = mockEmitFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'logStreamError'
      );
      assert.ok(errorCall, 'Should emit logStreamError');
      const errorData = errorCall?.arguments[1] as LogStreamError;
      assert.strictEqual(errorData.resourceId, 'test-resource');
      assert.ok(errorData.error.includes('log stream'));
    });
  });

  void describe('handleStopDevTools', () => {
    void it('calls shutdown service', async () => {
      service.setupSocketHandlers(mockSocket);
      const mockOnFn = mockSocket.on as unknown as MockFn;
      const foundCall = mockOnFn.mock.calls.find(
        (call: MockCall) => call.arguments[0] === 'stopDevTools'
      );
      
      assert.ok(foundCall, 'Could not find stopDevTools handler');
      const handler = foundCall?.arguments[1] as EventHandler;

      await handler();

      const mockShutdownFn = mockShutdownService.shutdown as unknown as MockFn;
      assert.strictEqual(mockShutdownFn.mock.callCount(), 1);
      
      // Check if there are any calls before accessing
      assert.ok(mockShutdownFn.mock.calls.length > 0, 'Should have at least one shutdown call');
      assert.deepStrictEqual(mockShutdownFn.mock.calls[0].arguments, [
        'user request', true
      ]);
    });
  });
});
