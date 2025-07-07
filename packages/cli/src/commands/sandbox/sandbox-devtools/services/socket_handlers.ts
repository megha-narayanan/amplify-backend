import { LogLevel, printer } from '@aws-amplify/cli-core';
import { Server, Socket } from 'socket.io';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Sandbox } from '@aws-amplify/sandbox';
import { LocalStorageManager } from '../local_storage_manager.js';
import { getLogGroupName } from '../logging/log_group_extractor.js';
import { ClientConfigFormat } from '@aws-amplify/client-config';
import { BackendIdentifier } from '@aws-amplify/plugin-types';
import { ResourceService } from './resource_service.js';
import {
  CloudFormationEventsService
} from '../logging/cloudformation_format.js';

/**
 * Interface for socket event data types
 */
export type SocketEvents = {
  toggleResourceLogging: {
    resourceId: string;
    resourceType: string;
    startLogging: boolean;
  };
  viewResourceLogs: {
    resourceId: string;
  };
  getSavedResourceLogs: {
    resourceId: string;
  };
  getActiveLogStreams: void;
  getLogSettings: void;
  saveLogSettings: {
    maxLogSizeMB: number;
  };
  getCustomFriendlyNames: void;
  updateCustomFriendlyName: {
    resourceId: string;
    friendlyName: string;
  };
  removeCustomFriendlyName: {
    resourceId: string;
  };
  getSandboxStatus: void;
  amplifyCloudFormationProgressUpdate: {
    message: string;
  };
  getDeployedBackendResources: void;
  startSandboxWithOptions: {
    identifier?: string;
    once?: boolean;
    dirToWatch?: string;
    exclude?: string;
    outputsFormat?: string;
    streamFunctionLogs?: boolean;
    logsFilter?: string;
    logsOutFile?: string;
    debugMode?: boolean;
  };
  stopSandbox: void;
  deleteSandbox: void;
  stopDevTools: void;
  getSavedDeploymentProgress: void;
  getSavedResources: void;
  getSavedCloudFormationEvents: void;
  testLambdaFunction: {
    resourceId: string;
    functionName: string;
    input: string;
  };
  getCloudFormationEvents: void;
};

/**
 * Service for handling socket events
 */
export class SocketHandlerService {
  /**
   * Creates a new SocketHandlerService
   */
  constructor(
    private io: Server,
    private sandbox: Sandbox,
    private getSandboxState: () => Promise<string>,
    private backendId: BackendIdentifier,
    private shutdownService: import('./shutdown_service.js').ShutdownService,
    private backendClient: Record<string, unknown>,
    private storageManager: LocalStorageManager,
    private resourceService: ResourceService,
    // eslint-disable-next-line spellcheck/spell-checker
    private activeLogPollers = new Map<string, NodeJS.Timeout>(),
    // Track when logging was toggled on for each resource
    private toggleStartTimes = new Map<string, number>(),
    // Track the timestamp of the last CloudFormation event we've seen for each sandbox
    private lastEventTimestamp: Record<string, Date> = {},
    // CloudFormation events service
    private cloudFormationEventsService = new CloudFormationEventsService(),
  ) {}

  /**
   * Sets up all socket event handlers
   * @param socket The socket connection
   */
  public setupSocketHandlers(socket: Socket): void {
    // Resource logs handlers
    socket.on(
      'toggleResourceLogging',
      this.handleToggleResourceLogging.bind(this, socket),
    );
    socket.on(
      'viewResourceLogs',
      this.handleViewResourceLogs.bind(this, socket),
    );
    socket.on(
      'getSavedResourceLogs',
      this.handleGetSavedResourceLogs.bind(this, socket),
    );
    socket.on(
      'getActiveLogStreams',
      this.handleGetActiveLogStreams.bind(this, socket),
    );
    
    // CloudFormation events handler
    socket.on(
      'getCloudFormationEvents',
      this.handleGetCloudFormationEvents.bind(this, socket),
    );

    // Log settings handlers
    socket.on('getLogSettings', this.handleGetLogSettings.bind(this, socket));
    socket.on('saveLogSettings', this.handleSaveLogSettings.bind(this, socket));

    // Friendly name handlers
    socket.on(
      'getCustomFriendlyNames',
      this.handleGetCustomFriendlyNames.bind(this, socket),
    );
    socket.on(
      'updateCustomFriendlyName',
      this.handleUpdateCustomFriendlyName.bind(this, socket),
    );
    socket.on(
      'removeCustomFriendlyName',
      this.handleRemoveCustomFriendlyName.bind(this, socket),
    );

    // Sandbox status handlers
    socket.on(
      'getSandboxStatus',
      this.handleGetSandboxStatus.bind(this, socket),
    );

    // Resource handlers
    socket.on(
      'getDeployedBackendResources',
      this.handleGetDeployedBackendResources.bind(this, socket),
    );
    socket.on(
      'getSavedResources',
      this.handleGetSavedResources.bind(this, socket),
    );
    socket.on(
      'getSavedCloudFormationEvents',
      this.handleGetSavedCloudFormationEvents.bind(this, socket),
    );

    // Sandbox operation handlers
    socket.on('startSandboxWithOptions', (options) =>
      this.handleStartSandboxWithOptions(options),
    );
    socket.on('stopSandbox', () => this.handleStopSandbox());
    socket.on('deleteSandbox', () => this.handleDeleteSandbox());

    // DevTools handlers
    socket.on('stopDevTools', this.handleStopDevTools.bind(this));

    // Lambda testing handler
    socket.on(
      'testLambdaFunction',
      this.handleTestLambdaFunction.bind(this, socket),
    );
  }

  /**
   * Handles the toggleResourceLogging event
   */
  private async handleToggleResourceLogging(
    socket: Socket,
    data: SocketEvents['toggleResourceLogging'],
  ): Promise<void> {
    printer.log(
      `Toggle logging for ${data.resourceId}, startLogging=${data.startLogging}`,
      LogLevel.DEBUG,
    );

    // Skip diagnostics - we'll catch any errors during the actual log fetching

    if (data.startLogging) {
      // Start logging if not already active
      // eslint-disable-next-line spellcheck/spell-checker
      if (!this.activeLogPollers.has(data.resourceId)) {
        try {
          // Check if resource type is defined
          if (!data.resourceType) {
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: 'Resource type is undefined. Cannot determine log group.',
            });
            return;
          }

          // Determine log group name based on resource type
          const logGroupName = getLogGroupName(
            data.resourceType,
            data.resourceId,
          );
          if (!logGroupName) {
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: `Unsupported resource type for logs: ${data.resourceType}`,
            });
            return;
          }

          // Notify client that we're starting to record logs
          socket.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'starting',
          });

          // Store the current time as the toggle start time
          this.toggleStartTimes.set(data.resourceId, Date.now());

          // Using polling-based logs directly
          printer.log(
            `Setting up polling-based logs for ${data.resourceId}`,
            LogLevel.INFO,
          );

          // Create CloudWatch Logs client
          const cwLogsClient = new CloudWatchLogsClient();

          // Get the latest log stream
          const describeStreamsResponse = await cwLogsClient.send(
            new DescribeLogStreamsCommand({
              logGroupName,
              orderBy: 'LastEventTime',
              descending: true,
              limit: 1,
            }),
          );

          if (
            !describeStreamsResponse.logStreams ||
            describeStreamsResponse.logStreams.length === 0
          ) {
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: 'No log streams found for this resource',
            });
            return;
          }

          const logStreamName =
            describeStreamsResponse.logStreams[0].logStreamName || '';
          let nextToken: string | undefined = undefined;

          // Function to fetch and save logs
          const fetchLogs = () => {
            void (async () => {
              try {
                const getLogsResponse = await cwLogsClient.send(
                  new GetLogEventsCommand({
                    logGroupName,
                    logStreamName,
                    nextToken,
                    startFromHead: true,
                  }),
                );

                // Update next token for next poll
                nextToken = getLogsResponse.nextForwardToken;

                // Process and save logs
                if (
                  getLogsResponse.events &&
                  getLogsResponse.events.length > 0
                ) {
                  // Get the toggle start time for this resource
                  const toggleStartTime =
                    this.toggleStartTimes.get(data.resourceId) || 0;

                  // Filter logs based on toggle start time
                  const logs = getLogsResponse.events
                    .filter((event) => (event.timestamp || 0) > toggleStartTime)
                    .map((event) => ({
                      timestamp: event.timestamp || Date.now(),
                      message: event.message || '',
                    }));

                  // Only save and emit if we have logs after filtering
                  if (logs.length > 0) {
                    // Save logs to local storage
                    logs.forEach(
                      (log: { timestamp: number; message: string }) => {
                        this.storageManager.appendCloudWatchLog(
                          data.resourceId,
                          log,
                        );
                      },
                    );

                    // Emit logs to all clients
                    this.io.emit('resourceLogs', {
                      resourceId: data.resourceId,
                      logs,
                    });
                  }
                }
              } catch (error) {
                printer.log(
                  `Error fetching logs for ${data.resourceId}: ${String(error)}`,
                  LogLevel.ERROR,
                );
                socket.emit('logStreamError', {
                  resourceId: data.resourceId,
                  error: `Error fetching logs: ${String(error)}`,
                });
              }
            })();
          };

          // Initial fetch
          fetchLogs();

          // Set up polling interval with more frequent polling since we're only using this approach
          const pollingInterval = setInterval(fetchLogs, 2000); // Poll every 2 seconds
          this.activeLogPollers.set(data.resourceId, pollingInterval);

          this.storageManager.saveResourceLoggingState(data.resourceId, true);

          // Notify client that logs are now being recorded
          socket.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'active',
          });

          // Also broadcast to all clients to ensure UI is updated everywhere
          this.io.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'active',
          });
        } catch (error) {
          // Check if this is a ResourceNotFoundException for missing log group
          if (
            String(error).includes('ResourceNotFoundException') &&
            String(error).includes('log group does not exist')
          ) {
            printer.log(
              `Log group does not exist yet for ${data.resourceId}`,
              LogLevel.INFO,
            );
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: `The log group doesn't exist yet. Try turning on logs again after the resource has produced some logs.`,
            });
          } else {
            printer.log(
              `Error starting log stream for ${data.resourceId}: ${String(error)}`,
              LogLevel.ERROR,
            );
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: `Failed to start log stream: ${String(error)}`,
            });
          }
        }
      } else {
        // Already recording logs
        socket.emit('logStreamStatus', {
          resourceId: data.resourceId,
          status: 'already-active',
        });
      }
    } else {
      // Stop logging
      const pollingInterval = this.activeLogPollers.get(data.resourceId);

      // Determine log group name based on resource type
      const logGroupName = getLogGroupName(data.resourceType, data.resourceId);
      if (!logGroupName) {
        socket.emit('logStreamError', {
          resourceId: data.resourceId,
          error: `Unsupported resource type for logs: ${data.resourceType}`,
        });
        return;
      }

      if (pollingInterval) {
        // Stop polling
        clearInterval(pollingInterval);
        // eslint-disable-next-line spellcheck/spell-checker
        this.activeLogPollers.delete(data.resourceId);

        printer.log(
          `Stopped log polling for resource ${data.resourceId}`,
          LogLevel.INFO,
        );
      }

      const existingLogs = this.storageManager.loadCloudWatchLogs(
        data.resourceId,
      );

      this.storageManager.saveResourceLoggingState(data.resourceId, false);

      // Notify client that logs are no longer being recorded
      socket.emit('logStreamStatus', {
        resourceId: data.resourceId,
        status: 'stopped',
      });

      // Send the saved logs back to the client to ensure they're not lost
      socket.emit('savedResourceLogs', {
        resourceId: data.resourceId,
        logs: existingLogs,
      });

      // Also broadcast to all clients to ensure UI is updated everywhere
      this.io.emit('logStreamStatus', {
        resourceId: data.resourceId,
        status: 'stopped',
      });

      printer.log(
        `Stopped logging for resource ${data.resourceId}`,
        LogLevel.INFO,
      );
    }
  }

  /**
   * Handles the viewResourceLogs event
   */
  private handleViewResourceLogs(
    socket: Socket,
    data: SocketEvents['viewResourceLogs'],
  ): void {
    printer.log(`Viewing logs for resource ${data.resourceId}`, LogLevel.DEBUG);

    try {
      // Load saved logs for this resource
      const logs = this.storageManager.loadCloudWatchLogs(data.resourceId);

      // Send logs to client
      socket.emit('savedResourceLogs', {
        resourceId: data.resourceId,
        logs: logs || [], // Ensure we always send an array, even if no logs exist
      });
    } catch (error) {
      printer.log(
        `Error handling viewResourceLogs event: ${String(error)}`,
        LogLevel.ERROR,
      );

      // Notify client of error
      socket.emit('logStreamError', {
        resourceId: data.resourceId,
        error: `Error loading logs: ${String(error)}`,
      });
    }
  }

  /**
   * Handles the getSavedResourceLogs event
   */
  private handleGetSavedResourceLogs(
    socket: Socket,
    data: SocketEvents['getSavedResourceLogs'],
  ): void {
    const logs = this.storageManager.loadCloudWatchLogs(data.resourceId);
    socket.emit('savedResourceLogs', {
      resourceId: data.resourceId,
      logs,
    });
  }

  /**
   * Handles the getActiveLogStreams event
   */
  private handleGetActiveLogStreams(socket: Socket): void {
    const resourceIds = this.storageManager.getResourcesWithActiveLogging();
    socket.emit('activeLogStreams', resourceIds);
  }

  /**
   * Handles the getLogSettings event
   */
  private handleGetLogSettings(socket: Socket): void {
    // Get current log size
    const currentSizeMB = this.storageManager.getLogsSizeInMB();

    socket.emit('logSettings', {
      maxLogSizeMB: this.storageManager.maxLogSizeMB || 50,
      currentSizeMB,
    });
  }

  /**
   * Handles the saveLogSettings event
   */
  private handleSaveLogSettings(
    socket: Socket,
    settings: SocketEvents['saveLogSettings'],
  ): void {
    if (!settings || typeof settings.maxLogSizeMB !== 'number') {
      return;
    }

    this.storageManager.setMaxLogSize(settings.maxLogSizeMB);

    // Get updated log size
    const currentSizeMB = this.storageManager.getLogsSizeInMB();

    // Broadcast the updated settings to all clients
    this.io.emit('logSettings', {
      maxLogSizeMB: settings.maxLogSizeMB,
      currentSizeMB,
    });

    printer.log(
      `Log settings updated: Max size set to ${settings.maxLogSizeMB} MB`,
      LogLevel.INFO,
    );
  }

  /**
   * Handles the getCustomFriendlyNames event
   */
  private handleGetCustomFriendlyNames(socket: Socket): void {
    const friendlyNames = this.storageManager.loadCustomFriendlyNames();
    socket.emit('customFriendlyNames', friendlyNames);
  }

  /**
   * Handles the updateCustomFriendlyName event
   */
  private handleUpdateCustomFriendlyName(
    socket: Socket,
    data: SocketEvents['updateCustomFriendlyName'],
  ): void {
    if (!data || !data.resourceId || !data.friendlyName) {
      return;
    }

    this.storageManager.updateCustomFriendlyName(
      data.resourceId,
      data.friendlyName,
    );

    // Broadcast the updated friendly name to all clients
    this.io.emit('customFriendlyNameUpdated', {
      resourceId: data.resourceId,
      friendlyName: data.friendlyName,
    });

    printer.log(
      `Custom friendly name updated for ${data.resourceId}: ${data.friendlyName}`,
      LogLevel.INFO,
    );
  }

  /**
   * Handles the removeCustomFriendlyName event
   */
  private handleRemoveCustomFriendlyName(
    socket: Socket,
    data: SocketEvents['removeCustomFriendlyName'],
  ): void {
    if (!data || !data.resourceId) {
      return;
    }

    this.storageManager.removeCustomFriendlyName(data.resourceId);

    // Broadcast the removal to all clients
    this.io.emit('customFriendlyNameRemoved', {
      resourceId: data.resourceId,
    });

    printer.log(
      `Custom friendly name removed for ${data.resourceId}`,
      LogLevel.INFO,
    );
  }

  /**
   * Handles the getSandboxStatus event
   */
  private async handleGetSandboxStatus(socket: Socket): Promise<void> {
    try {
      printer.log(
        'Received getSandboxStatus request from client',
        LogLevel.INFO,
      );
      const status = await this.getSandboxState();

      // Add a timestamp to help with debugging
      const timestamp = new Date().toISOString();

      socket.emit('sandboxStatus', {
        status,
        identifier: this.backendId.name,
        timestamp,
      });
    } catch (error) {
      printer.log(
        `Error getting sandbox status on request: ${String(error)}`,
        LogLevel.ERROR,
      );
      socket.emit('sandboxStatus', {
        status: 'unknown',
        error: `${String(error)}`,
        identifier: this.backendId.name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Handles the getDeployedBackendResources event
   */
  private async handleGetDeployedBackendResources(
    socket: Socket,
  ): Promise<void> {
    try {
      printer.log('Fetching deployed backend resources...', LogLevel.INFO);

      try {
        // Use the ResourceService to get deployed backend resources
        const resources =
          await this.resourceService.getDeployedBackendResources();
        socket.emit('deployedBackendResources', resources);
      } catch (error) {
        printer.log(
          `Error checking sandbox status: ${String(error)}`,
          LogLevel.ERROR,
        );
        // Ensure we send a consistent response type even for unexpected errors
        socket.emit('deployedBackendResources', {
          name: this.backendId.name,
          status: 'error',
          resources: [],
          region: null,
          message: `Error checking sandbox status: ${String(error)}`,
          error: String(error),
        });
      }
    } catch (error) {
      printer.log(
        `Error in handleGetDeployedBackendResources: ${String(error)}`,
        LogLevel.ERROR,
      );
      socket.emit('deployedBackendResources', {
        name: this.backendId.name,
        status: 'error',
        resources: [],
        region: null,
        message: `Error handling resource request: ${String(error)}`,
        error: String(error),
      });
    }
  }


  /**
   * Handles the getSavedResources event
   */
  private handleGetSavedResources(socket: Socket): void {
    const resources = this.storageManager.loadResources();
    socket.emit('savedResources', resources || []);
  }

  /**
   * Handles the getSavedCloudFormationEvents event
   */
  private handleGetSavedCloudFormationEvents(socket: Socket): void {
    const events = this.storageManager.loadCloudFormationEvents();
    socket.emit('savedCloudFormationEvents', events);
  }

  /**
   * Handles the startSandboxWithOptions event
   */
  private async handleStartSandboxWithOptions(
    options: SocketEvents['startSandboxWithOptions'],
  ): Promise<void> {
    try {
      printer.log(
        `Starting sandbox with options: ${JSON.stringify(options)}`,
        LogLevel.DEBUG,
      );
  
      // Prepare sandbox options
      const sandboxOptions = {
        dir: options.dirToWatch || './amplify',
        exclude: options.exclude ? options.exclude.split(',') : undefined,
        identifier: options.identifier,
        format: options.outputsFormat as ClientConfigFormat | undefined,
        watchForChanges: !options.once,
        functionStreamingOptions: {
          enabled: options.streamFunctionLogs || false,
          logsFilters: options.logsFilter
            ? options.logsFilter.split(',')
            : undefined,
          logsOutFile: options.logsOutFile,
        },
      };

      // Actually start the sandbox
      // The sandbox will emit events that update the UI status
      await this.sandbox.start(sandboxOptions);

      printer.log('Sandbox start command issued successfully', LogLevel.DEBUG);
    } catch (error) {
      printer.log(`Error starting sandbox: ${String(error)}`, LogLevel.ERROR);
      throw error;
    }
  }

  /**
   * Handles the stopSandbox event
   */
  private async handleStopSandbox(): Promise<void> {
    try {
      printer.log('Stopping sandbox...', LogLevel.INFO);

      // Stop the sandbox
      // The sandbox will emit events that update the UI status
      await this.sandbox.stop(); 
      
      printer.log('Sandbox stop command issued successfully', LogLevel.DEBUG);
    } catch (error) {
      printer.log(`Error stopping sandbox: ${String(error)}`, LogLevel.ERROR);
      
      // Send error status to client instead of throwing
      if (this.io) {
        this.io.emit('sandboxStatus', {
          status: await this.getSandboxState(),
          error: true,
          message: `Error stopping sandbox: ${String(error)}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Handles the deleteSandbox event
   */
  private async handleDeleteSandbox(): Promise<void> {
    try {
      printer.log('Deleting sandbox...', LogLevel.INFO);

      // Delete the sandbox
      // The sandbox will emit events that update the UI status
      await this.sandbox.delete({ identifier: this.backendId.name });

      printer.log('Sandbox delete command issued successfully', LogLevel.DEBUG);
    } catch (error) {
      printer.log(`Error deleting sandbox: ${String(error)}`, LogLevel.ERROR);
      throw error;
    }
  }

  /**
   * Handles the stopDevTools event
   */
  private async handleStopDevTools(): Promise<void> {
    await this.shutdownService.shutdown('user request', true);
  }

  /**
   * Handles the testLambdaFunction event
   */
  private async handleTestLambdaFunction(
    socket: Socket,
    data: SocketEvents['testLambdaFunction'],
  ): Promise<void> {
    try {
      printer.log(
        `Testing Lambda function ${data.functionName} with input: ${data.input}`,
        LogLevel.DEBUG,
      );

      const lambdaClient = new LambdaClient({});
      
      const result = await lambdaClient.send(
        new InvokeCommand({
          FunctionName: data.functionName,
          Payload: new TextEncoder().encode(data.input),
        }),
      );

      let responsePayload = result.Payload
        ? new TextDecoder().decode(result.Payload)
        : 'No response payload';

      // Try to parse and format the response
        const parsed = JSON.parse(responsePayload);
        if (parsed.body && typeof parsed.body === 'string') {
          // Try to parse the body if it's a JSON string
          try {
            const parsedBody = JSON.parse(parsed.body);
            responsePayload = JSON.stringify({ ...parsed, body: parsedBody }, null, 2);
          } catch {
            // If body parsing fails, just format the outer JSON
            responsePayload = JSON.stringify(parsed, null, 2);
          }
        } else {
          responsePayload = JSON.stringify(parsed, null, 2);
        }

      socket.emit('lambdaTestResult', {
        resourceId: data.resourceId,
        result: responsePayload,
      });

      printer.log(
        `Lambda function ${data.functionName} test completed successfully`,
        LogLevel.INFO,
      );
    } catch (error) {
      printer.log(
        `Error testing Lambda function ${data.functionName}: ${String(error)}`,
        LogLevel.ERROR,
      );
      
      socket.emit('lambdaTestResult', {
        resourceId: data.resourceId,
        error: String(error),
      });
    }
  }
  
  /**
   * Handles the getCloudFormationEvents event
   * Fetches CloudFormation events directly from the AWS API
   */
  private async handleGetCloudFormationEvents(
  socket: Socket
): Promise<void> {
  try {
    
    // Get current sandbox state
    const sandboxState = this.sandbox.getState();
    
    // Don't fetch events if sandbox doesn't exist
    if (sandboxState === 'nonexistent') {
      return;
    }
    
    // If not deploying or deleting, we can return a cached version if available
    const shouldUseCachedEvents = 
      sandboxState !== 'deploying' && 
      sandboxState !== 'deleting';
    
    if (shouldUseCachedEvents) {
      // Try to get cached events first
      const cachedEvents = this.storageManager.loadCloudFormationEvents();
      
      if (cachedEvents && cachedEvents.length > 0) {
        socket.emit('cloudFormationEvents', cachedEvents);
        return;
      }
    }
    
    // Only get events since the last one we've seen if we're in an active deployment or deletion
    const sinceTimestamp = 
      (sandboxState === 'deploying' || sandboxState === 'deleting')
        ? this.lastEventTimestamp[this.backendId.name] 
        : undefined;
     
    // Fetch fresh events from CloudFormation API
    const events = await this.cloudFormationEventsService.getStackEvents(
      this.backendId, 
      sinceTimestamp
    );

    // Only proceed if we have new events
    if (events.length === 0) {
      return;
    }
    
    // Update the last event timestamp if we got any events
    const latestEvent = events.reduce((latest, event) => 
      !latest || (event.timestamp > latest.timestamp) ? event : latest
    , null as any);
    
    if (latestEvent) {
      this.lastEventTimestamp[this.backendId.name] = latestEvent.timestamp;
    }

    
    // Map events to the format expected by the frontend
    const formattedEvents = events.map(event => {
      const resourceStatus = this.cloudFormationEventsService.convertToResourceStatus(event);
      return {
        message: `${event.timestamp.toLocaleTimeString()} | ${event.status} | ${event.resourceType} | ${event.logicalId}`,
        timestamp: event.timestamp.toISOString(),
        resourceStatus,
        isGeneric: false
      };
    });

    // Cache events if we're not in an active deployment
    if (shouldUseCachedEvents && formattedEvents.length > 0) {
      this.storageManager.saveCloudFormationEvents(formattedEvents);
    }
    
    socket.emit('cloudFormationEvents', formattedEvents);
  } catch (error) {
    printer.log(`Error fetching CloudFormation events: ${String(error)}`, LogLevel.ERROR);
    socket.emit('cloudFormationEventsError', {
      error: String(error)
    });
  }
}
}
