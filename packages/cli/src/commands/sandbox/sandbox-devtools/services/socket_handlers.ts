import { LogLevel, printer } from '@aws-amplify/cli-core';
import { Server, Socket } from 'socket.io';
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DeployedBackendClientFactory } from '@aws-amplify/deployed-backend-client';
import { S3Client } from '@aws-sdk/client-s3';
import { AmplifyClient } from '@aws-sdk/client-amplify';
import { LocalStorageManager } from '../local_storage_manager.js';
import { LogStreamingService } from './log_streaming_service.js';
import { getLogGroupName } from '../utils/logging_utils.js';
import { createFriendlyName } from '../utils/cloudformation_utils.js';
import { ResourceWithFriendlyName } from '../resource_console_functions.js';

/**
 * Interface for socket event data types
 */
export interface SocketEvents {
  toggleResourceLogging: { 
    resourceId: string; 
    resourceType: string; 
    startLogging: boolean 
  };
  viewResourceLogs: { 
    resourceId: string 
  };
  getSavedResourceLogs: { 
    resourceId: string 
  };
  getActiveLogStreams: void;
  getLogSettings: void;
  saveLogSettings: { 
    maxLogSizeMB: number 
  };
  getCustomFriendlyNames: void;
  updateCustomFriendlyName: { 
    resourceId: string; 
    friendlyName: string 
  };
  removeCustomFriendlyName: { 
    resourceId: string 
  };
  getSandboxStatus: void;
  deploymentInProgress: { 
    message: string; 
    timestamp: string 
  };
  AMPLIFY_CFN_PROGRESS_UPDATE: { 
    message: string 
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
    profile?: string 
  };
  stopSandbox: void;
  deleteSandbox: void;
  stopDevTools: void;
  getSavedDeploymentProgress: void;
  getSavedResources: void;
}

/**
 * Service for handling socket events
 */
export class SocketHandlerService {
  private io: Server;
  private storageManager: LocalStorageManager;
  private logStreamingService: LogStreamingService;
  private activeLogPollers = new Map<string, NodeJS.Timeout>();
  private sandbox: any; // Using any for now, should be replaced with proper type
  private getSandboxState: () => string;
  private backendId: { name: string };
  private shutdownService: any; // Using any for now, should be replaced with proper type
  private backendClient: any; // Client for fetching backend resources

  /**
   * Creates a new SocketHandlerService
   */
  constructor(
    io: Server,
    storageManager: LocalStorageManager,
    logStreamingService: LogStreamingService,
    sandbox: any,
    getSandboxState: () => string,
    backendId: { name: string },
    shutdownService: any,
    backendClient?: any
  ) {
    this.io = io;
    this.storageManager = storageManager;
    this.logStreamingService = logStreamingService;
    this.sandbox = sandbox;
    this.getSandboxState = getSandboxState;
    this.backendId = backendId;
    this.shutdownService = shutdownService;
    this.backendClient = backendClient
  }

  /**
   * Sets up all socket event handlers
   * @param socket The socket connection
   */
  public setupSocketHandlers(socket: Socket): void {
    // Resource logs handlers
    socket.on('toggleResourceLogging', this.handleToggleResourceLogging.bind(this, socket));
    socket.on('viewResourceLogs', this.handleViewResourceLogs.bind(this, socket));
    socket.on('getSavedResourceLogs', this.handleGetSavedResourceLogs.bind(this, socket));
    socket.on('getActiveLogStreams', this.handleGetActiveLogStreams.bind(this, socket));
    
    // Log settings handlers
    socket.on('getLogSettings', this.handleGetLogSettings.bind(this, socket));
    socket.on('saveLogSettings', this.handleSaveLogSettings.bind(this, socket));
    
    // Friendly name handlers
    socket.on('getCustomFriendlyNames', this.handleGetCustomFriendlyNames.bind(this, socket));
    socket.on('updateCustomFriendlyName', this.handleUpdateCustomFriendlyName.bind(this, socket));
    socket.on('removeCustomFriendlyName', this.handleRemoveCustomFriendlyName.bind(this, socket));
    
    // Sandbox status handlers
    socket.on('getSandboxStatus', this.handleGetSandboxStatus.bind(this, socket));
    socket.on('deploymentInProgress', this.handleDeploymentInProgress.bind(this, socket));
    socket.on('AMPLIFY_CFN_PROGRESS_UPDATE', this.handleAmplifyCloudFormationProgressUpdate.bind(this, socket));
    
    // Resource handlers
    socket.on('getDeployedBackendResources', this.handleGetDeployedBackendResources.bind(this, socket));
    socket.on('getSavedDeploymentProgress', this.handleGetSavedDeploymentProgress.bind(this, socket));
    socket.on('getSavedResources', this.handleGetSavedResources.bind(this, socket));
    
    // Sandbox operation handlers
    socket.on('startSandboxWithOptions', this.handleStartSandboxWithOptions.bind(this, socket));
    socket.on('stopSandbox', this.handleStopSandbox.bind(this, socket));
    socket.on('deleteSandbox', this.handleDeleteSandbox.bind(this, socket));
    
    // DevTools handlers
    socket.on('stopDevTools', this.handleStopDevTools.bind(this, socket));
  }

  /**
   * Handles the toggleResourceLogging event
   */
  private async handleToggleResourceLogging(socket: Socket, data: SocketEvents['toggleResourceLogging']): Promise<void> {
    printer.log(`Toggle logging for ${data.resourceId}, startLogging=${data.startLogging}`, LogLevel.DEBUG);
    
    // Run diagnostics first to check AWS service health
    try {
      const diagnosticResults = await this.logStreamingService.runDiagnostics();
      printer.log(`AWS service diagnostics: ${JSON.stringify(diagnosticResults)}`, LogLevel.DEBUG);
      
      // If any service is not accessible, notify the client
      if (!diagnosticResults.lambdaServiceAccessible || 
          !diagnosticResults.cloudWatchLogsServiceAccessible || 
          !diagnosticResults.iamServiceAccessible) {
        socket.emit('logStreamError', {
          resourceId: data.resourceId,
          error: 'AWS service connectivity issues detected. Check your AWS credentials and network connectivity.'
        });
        return;
      }
    } catch (error) {
      printer.log(`Error running diagnostics: ${error}`, LogLevel.ERROR);
    }
    
    if (data.startLogging) {
      // Start logging if not already active
      if (!this.activeLogPollers.has(data.resourceId)) {
        try {
          // Check if resource type is defined
          if (!data.resourceType) {
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: 'Resource type is undefined. Cannot determine log group.'
            });
            return;
          }
          
          // Determine log group name based on resource type
          const logGroupName = getLogGroupName(data.resourceType, data.resourceId);
          if (!logGroupName) {
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: `Unsupported resource type for logs: ${data.resourceType}`
            });
            return;
          }
          
          // Notify client that we're starting to record logs
          socket.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'starting'
          });
          
          // Try to set up real-time log streaming first
          const subscriptionSuccess = await this.logStreamingService.setupLogSubscription(logGroupName, data.resourceId);
          
          if (subscriptionSuccess) {
            // Real-time log streaming set up successfully
            printer.log(`Real-time log streaming set up for ${data.resourceId}`, LogLevel.INFO);
            
            // Save the logging state to local storage
            this.storageManager.saveResourceLoggingState(data.resourceId, true);
            
            // Notify client that logs are now being recorded
            socket.emit('logStreamStatus', {
              resourceId: data.resourceId,
              status: 'active'
            });
            
            // Also broadcast to all clients to ensure UI is updated everywhere
            this.io.emit('logStreamStatus', {
              resourceId: data.resourceId,
              status: 'active'
            });
            
            return;
          }
          
          // If real-time log streaming failed, fall back to polling
          printer.log(`Falling back to polling-based logs for ${data.resourceId}`, LogLevel.INFO);
          
          // Create CloudWatch Logs client
          const cwLogsClient = new CloudWatchLogsClient();
          
          // Get the latest log stream
          const describeStreamsResponse = await cwLogsClient.send(
            new DescribeLogStreamsCommand({
              logGroupName,
              orderBy: 'LastEventTime',
              descending: true,
              limit: 1
            })
          );
          
          if (!describeStreamsResponse.logStreams || describeStreamsResponse.logStreams.length === 0) {
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: 'No log streams found for this resource'
            });
            return;
          }
          
          const logStreamName = describeStreamsResponse.logStreams[0].logStreamName || '';
          let nextToken: string | undefined = undefined;
          
          // Function to fetch and save logs
          const fetchLogs = async () => {
            try {
              const getLogsResponse = await cwLogsClient.send(
                new GetLogEventsCommand({
                  logGroupName,
                  logStreamName,
                  nextToken,
                  startFromHead: true
                })
              );
              
              // Update next token for next poll
              nextToken = getLogsResponse.nextForwardToken;
              
              // Process and save logs
              if (getLogsResponse.events && getLogsResponse.events.length > 0) {
                const logs = getLogsResponse.events.map(event => ({
                  timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
                  message: event.message || ''
                }));
                
                // Save logs to local storage
                logs.forEach((log: { timestamp: string; message: string }) => {
                  this.storageManager.appendCloudWatchLog(data.resourceId, log);
                });
                
                // Emit logs to all clients
                this.io.emit('resourceLogs', {
                  resourceId: data.resourceId,
                  logs
                });
              }
            } catch (error) {
              printer.log(`Error fetching logs for ${data.resourceId}: ${error}`, LogLevel.ERROR);
              socket.emit('logStreamError', {
                resourceId: data.resourceId,
                error: `Error fetching logs: ${error}`
              });
            }
          };
          
          // Initial fetch
          await fetchLogs();
          
          // Set up polling interval
          const pollingInterval = setInterval(fetchLogs, 5000); // Poll every 5 seconds
          
          // Store polling interval
          this.activeLogPollers.set(data.resourceId, pollingInterval);
          
          // Save the logging state to local storage
          this.storageManager.saveResourceLoggingState(data.resourceId, true);
          
          // Notify client that logs are now being recorded
          socket.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'active'
          });
          
          // Also broadcast to all clients to ensure UI is updated everywhere
          this.io.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'active'
          });
          
        } catch (error) {
          printer.log(`Error starting log stream for ${data.resourceId}: ${error}`, LogLevel.ERROR);
          socket.emit('logStreamError', {
            resourceId: data.resourceId,
            error: `Failed to start log stream: ${error}`
          });
        }
      } else {
        // Already recording logs
        socket.emit('logStreamStatus', {
          resourceId: data.resourceId,
          status: 'already-active'
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
          error: `Unsupported resource type for logs: ${data.resourceType}`
        });
        return;
      }
      
      // Try to remove subscription filter if it exists
      await this.logStreamingService.removeLogSubscription(logGroupName, data.resourceId);
      
      if (pollingInterval) {
        // Stop polling
        clearInterval(pollingInterval);
        this.activeLogPollers.delete(data.resourceId);
        
        printer.log(`Stopped log polling for resource ${data.resourceId}`, LogLevel.INFO);
      }
      
      // Make sure we don't lose any logs when stopping
      const existingLogs = this.storageManager.loadCloudWatchLogs(data.resourceId);
      printer.log(`DEBUG: Found ${existingLogs.length} existing logs for ${data.resourceId} before stopping`, LogLevel.DEBUG);
      
      // Save the logging state to local storage
      printer.log(`DEBUG: Saving inactive logging state for resource ${data.resourceId}`, LogLevel.DEBUG);
      this.storageManager.saveResourceLoggingState(data.resourceId, false);
      
      // Notify client that logs are no longer being recorded
      socket.emit('logStreamStatus', {
        resourceId: data.resourceId,
        status: 'stopped'
      });
      
      // Send the saved logs back to the client to ensure they're not lost
      socket.emit('savedResourceLogs', {
        resourceId: data.resourceId,
        logs: existingLogs
      });
      
      // Also broadcast to all clients to ensure UI is updated everywhere
      this.io.emit('logStreamStatus', {
        resourceId: data.resourceId,
        status: 'stopped'
      });
      
      printer.log(`Stopped logging for resource ${data.resourceId}`, LogLevel.INFO);
    }
  }

  /**
   * Handles the viewResourceLogs event
   */
  private handleViewResourceLogs(socket: Socket, data: SocketEvents['viewResourceLogs']): void {
    printer.log(`Viewing logs for resource ${data.resourceId}`, LogLevel.DEBUG);
    
    try {
      // Load saved logs for this resource
      const logs = this.storageManager.loadCloudWatchLogs(data.resourceId);
      
      // Send logs to client
      socket.emit('savedResourceLogs', {
        resourceId: data.resourceId,
        logs: logs || [] // Ensure we always send an array, even if no logs exist
      });
    } catch (error) {
      printer.log(`Error handling viewResourceLogs event: ${error}`, LogLevel.ERROR);
      
      // Notify client of error
      socket.emit('logStreamError', {
        resourceId: data.resourceId,
        error: `Error loading logs: ${error}`
      });
    }
  }

  /**
   * Handles the getSavedResourceLogs event
   */
  private handleGetSavedResourceLogs(socket: Socket, data: SocketEvents['getSavedResourceLogs']): void {
    printer.log(`DEBUG: getSavedResourceLogs event received for ${data.resourceId}`, LogLevel.DEBUG);
    const logs = this.storageManager.loadCloudWatchLogs(data.resourceId);
    printer.log(`DEBUG: Found ${logs.length} saved logs for ${data.resourceId}`, LogLevel.DEBUG);
    socket.emit('savedResourceLogs', {
      resourceId: data.resourceId,
      logs
    });
  }

  /**
   * Handles the getActiveLogStreams event
   */
  private handleGetActiveLogStreams(socket: Socket): void {
    printer.log('DEBUG: getActiveLogStreams event received', LogLevel.DEBUG);
    // Use getResourcesWithActiveLogging instead of getResourcesWithCloudWatchLogs
    // to only return resources that are actively being logged
    const resourceIds = this.storageManager.getResourcesWithActiveLogging();
    printer.log(`DEBUG: Active log streams: ${resourceIds.join(', ') || 'none'}`, LogLevel.DEBUG);
    socket.emit('activeLogStreams', resourceIds);
  }

  /**
   * Handles the getLogSettings event
   */
  private handleGetLogSettings(socket: Socket): void {
    printer.log('DEBUG: getLogSettings event received', LogLevel.DEBUG);
    // Get current log size
    const currentSizeMB = this.storageManager.getLogsSizeInMB();
    
    socket.emit('logSettings', { 
      maxLogSizeMB: this.storageManager.maxLogSizeMB || 50,
      currentSizeMB
    });
  }

  /**
   * Handles the saveLogSettings event
   */
  private handleSaveLogSettings(socket: Socket, settings: SocketEvents['saveLogSettings']): void {
    printer.log(`DEBUG: saveLogSettings event received: ${JSON.stringify(settings)}`, LogLevel.DEBUG);
    if (settings && typeof settings.maxLogSizeMB === 'number') {
      this.storageManager.setMaxLogSize(settings.maxLogSizeMB);
      
      // Get updated log size
      const currentSizeMB = this.storageManager.getLogsSizeInMB();
      
      // Broadcast the updated settings to all clients
      this.io.emit('logSettings', { 
        maxLogSizeMB: settings.maxLogSizeMB,
        currentSizeMB
      });
      
      printer.log(`Log settings updated: Max size set to ${settings.maxLogSizeMB} MB`, LogLevel.INFO);
    }
  }

  /**
   * Handles the getCustomFriendlyNames event
   */
  private handleGetCustomFriendlyNames(socket: Socket): void {
    printer.log('DEBUG: getCustomFriendlyNames event received', LogLevel.DEBUG);
    const friendlyNames = this.storageManager.loadCustomFriendlyNames();
    socket.emit('customFriendlyNames', friendlyNames);
  }

  /**
   * Handles the updateCustomFriendlyName event
   */
  private handleUpdateCustomFriendlyName(socket: Socket, data: SocketEvents['updateCustomFriendlyName']): void {
    printer.log(`DEBUG: updateCustomFriendlyName event received for ${data.resourceId}: ${data.friendlyName}`, LogLevel.DEBUG);
    if (data && data.resourceId && data.friendlyName) {
      this.storageManager.updateCustomFriendlyName(data.resourceId, data.friendlyName);
      
      // Broadcast the updated friendly name to all clients
      this.io.emit('customFriendlyNameUpdated', { 
        resourceId: data.resourceId,
        friendlyName: data.friendlyName
      });
      
      printer.log(`Custom friendly name updated for ${data.resourceId}: ${data.friendlyName}`, LogLevel.INFO);
    }
  }

  /**
   * Handles the removeCustomFriendlyName event
   */
  private handleRemoveCustomFriendlyName(socket: Socket, data: SocketEvents['removeCustomFriendlyName']): void {
    printer.log(`DEBUG: removeCustomFriendlyName event received for ${data.resourceId}`, LogLevel.DEBUG);
    if (data && data.resourceId) {
      this.storageManager.removeCustomFriendlyName(data.resourceId);
      
      // Broadcast the removal to all clients
      this.io.emit('customFriendlyNameRemoved', { 
        resourceId: data.resourceId
      });
      
      printer.log(`Custom friendly name removed for ${data.resourceId}`, LogLevel.INFO);
    }
  }

  /**
   * Handles the getSandboxStatus event
   */
  private handleGetSandboxStatus(socket: Socket): void {
    try {
      const status = this.getSandboxState();
      
      socket.emit('sandboxStatus', { 
        status,
        identifier: this.backendId.name 
      });
    } catch (error) {
      printer.log(`Error getting sandbox status on request: ${error}`, LogLevel.ERROR);
      socket.emit('sandboxStatus', { 
        status: 'unknown', 
        error: `${error}`,
        identifier: this.backendId.name 
      });
    }
  }

  /**
   * Handles the deploymentInProgress event
   */
  private handleDeploymentInProgress(socket: Socket, data: SocketEvents['deploymentInProgress']): void {
    printer.log(`Deployment in progress: ${data.message}`, LogLevel.INFO);
    // Broadcast to all clients
    this.io.emit('deploymentInProgress', data);
  }
  
  /**
   * Fetches backend resources and processes them
   * @returns The processed resources or null if there was an error
   */
  private async fetchBackendResources(): Promise<Record<string, any> | null> {
    try {
      // Get the current sandbox state
      const status = this.getSandboxState();
      
      // If sandbox is not running, don't try to fetch resources
      if (status !== 'running') {
        printer.log(`Sandbox is not running (status: ${status}), cannot fetch resources`, LogLevel.DEBUG);
        return null;
      }
      
      printer.log('Fetching backend metadata...', LogLevel.DEBUG);
      const data = await this.backendClient.getBackendMetadata(this.backendId);
      printer.log(`Successfully fetched backend metadata with ${data.resources?.length || 0} resources`, LogLevel.INFO);

      const cfnClient = new CloudFormationClient();
      const regionValue = cfnClient.config.region;

      let region = null;

      try {
        if (typeof regionValue === 'function') {
          if (regionValue.constructor.name === 'AsyncFunction') {
            region = await regionValue();
          } else {
            region = regionValue();
          }
        } else if (regionValue) {
          region = String(regionValue);
        }

        // Final check to ensure region is a string
        if (region && typeof region !== 'string') {
          region = String(region);
        }
      } catch (error) {
        printer.log('Error processing region: ' + error, LogLevel.ERROR);
        region = null;
      }

      // Process resources and add friendly names
      const resourcesWithFriendlyNames = data.resources.map((resource: any) => {
        const logicalId = resource.logicalResourceId || '';
        let resourceType = resource.resourceType || '';
        
        // Remove CUSTOM:: prefix from resource type
        if (resourceType.startsWith('CUSTOM::')) {
          resourceType = resourceType.substring(8); // Remove "CUSTOM::" (8 characters)
        } else if (resourceType.startsWith('Custom::')) {
          resourceType = resourceType.substring(8); // Remove "Custom::" (8 characters)
        }
        
        // Check if the resource has metadata with a construct path
        const metadata = 'metadata' in resource && 
                        typeof resource.metadata === 'object' && 
                        resource.metadata !== null && 
                        'constructPath' in resource.metadata ? { 
          constructPath: resource.metadata.constructPath as string
        } : undefined;
        
        return {
          ...resource,
          resourceType: resourceType,
          friendlyName: createFriendlyName(logicalId, metadata),
        } as ResourceWithFriendlyName;
      });

      // Add region and resources with friendly names to the data
      const enhancedData = {
        ...data,
        region,
        resources: resourcesWithFriendlyNames,
        status
      };
      
      // Save resources to local storage for persistence
      this.storageManager.saveResources(enhancedData);
      
      return enhancedData;
    } catch (error) {
      const errorMessage = String(error);
      printer.log(`Error fetching backend resources: ${errorMessage}`, LogLevel.ERROR);
      throw error;
    }
  }

  /**
   * Handles the AMPLIFY_CFN_PROGRESS_UPDATE event
   */
  private async handleAmplifyCloudFormationProgressUpdate(socket: Socket, data: SocketEvents['AMPLIFY_CFN_PROGRESS_UPDATE']): Promise<void> {
    printer.log(`CloudFormation progress update received`, LogLevel.DEBUG);
    // Extract CloudFormation events from the message
    const cfnEvents = this.extractCloudFormationEvents(data.message);
    
    // Check if any event indicates deployment completion
    let deploymentCompleted = false;
    
    // Send each event to the client
    for (const event of cfnEvents) {
      if (event) {
        this.io.emit('deploymentInProgress', {
          message: event,
          timestamp: new Date().toISOString()
        });
        
        // Check if this event indicates stack completion
        // Look specifically for the root stack completion which indicates the entire deployment is done
        if ((event.includes('CREATE_COMPLETE') || event.includes('UPDATE_COMPLETE')) && 
            event.includes('AWS::CloudFormation::Stack')) {
          printer.log('Detected CloudFormation stack completion event', LogLevel.INFO);
          deploymentCompleted = true;
        }
      }
    }
    
    // If deployment completed, clear resources
    if (deploymentCompleted) {
      this.storageManager.clearResources();
    }
  }

  /**
   * Handles the getDeployedBackendResources event
   */
  private async handleGetDeployedBackendResources(socket: Socket): Promise<void> {
    try {
      printer.log('Fetching deployed backend resources...', LogLevel.INFO);
      
      // Get the current sandbox state
      const status = this.getSandboxState();
      
      // Try to use saved resources first, regardless of sandbox state
      // Resources only change after deployments, which we handle separately
      const savedResources = this.storageManager.loadResources();
      if (savedResources) {
        printer.log('Found saved resources, returning them', LogLevel.INFO);
        socket.emit('deployedBackendResources', {
          ...savedResources,
          status
        });
        return;
      }
      
      // If no saved resources, handle based on sandbox state
      if (status === 'running') {
        printer.log('No saved resources found and sandbox is running, fetching resources', LogLevel.INFO);
        try {
          const enhancedData = await this.fetchBackendResources();
          
          if (enhancedData) {
            socket.emit('deployedBackendResources', enhancedData);
            return;
          }
        } catch (error) {
          const errorMessage = String(error);
          printer.log(`Error getting backend resources: ${errorMessage}`, LogLevel.ERROR);
          
          // Check if this is a deployment in progress error
          if (errorMessage.includes('deployment is in progress')) {
            socket.emit('deployedBackendResources', {
              name: this.backendId.name,
              status: 'deploying',
              resources: [],
              region: null,
              message: 'Sandbox deployment is in progress. Resources will update when deployment completes.'
            });
          } else if (errorMessage.includes('does not exist')) {
            socket.emit('deployedBackendResources', {
              name: this.backendId.name,
              status: 'nonexistent',
              resources: [],
              region: null,
              message: 'No sandbox exists. Please create a sandbox first.'
            });
          } else {
            socket.emit('deployedBackendResources', {
              name: this.backendId.name,
              status: 'error',
              resources: [],
              region: null,
              message: `Error fetching resources: ${errorMessage}`,
              error: errorMessage
            });
          }
          return;
        }
      } else if (status === 'stopped' || status === 'deploying') {
        // For stopped sandbox with no saved resources, return basic info
        printer.log('Sandbox is stopped and no saved resources found', LogLevel.INFO);
        socket.emit('deployedBackendResources', {
          name: this.backendId.name,
          status: status,
          resources: [],
          region: null,
          message: 'Sandbox is not running and no saved resources were found. Start the sandbox to see resources.'
        });
        return;
      } else if (status === 'nonexistent') {
        // For nonexistent sandbox, return appropriate message
        socket.emit('deployedBackendResources', {
          name: this.backendId.name,
          status: 'nonexistent',
          resources: [],
          region: null,
          message: 'No sandbox exists. Please create a sandbox first.'
        });
        return;
      }
      
      // If we get here, something unexpected happened
      socket.emit('deployedBackendResources', {
        name: this.backendId.name,
        status: status || 'unknown',
        resources: [],
        region: null,
        message: `Could not determine sandbox resources. Status: ${status}`
      });
    } catch (error) {
      printer.log(`Error checking sandbox status: ${error}`, LogLevel.ERROR);
      // Ensure we send a consistent response type even for unexpected errors
      socket.emit('deployedBackendResources', {
        name: this.backendId.name,
        status: 'error',
        resources: [],
        region: null,
        message: `Error checking sandbox status: ${error}`,
        error: String(error)
      });
    }
  }

  /**
   * Handles the getSavedDeploymentProgress event
   */
  private handleGetSavedDeploymentProgress(socket: Socket): void {
    printer.log('DEBUG: getSavedDeploymentProgress event received', LogLevel.DEBUG);
    const events = this.storageManager.loadDeploymentProgress();
    socket.emit('savedDeploymentProgress', events);
  }

  /**
   * Handles the getSavedResources event
   */
  private handleGetSavedResources(socket: Socket): void {
    printer.log('DEBUG: getSavedResources event received', LogLevel.DEBUG);
    const resources = this.storageManager.loadResources();
    if (resources) {
      socket.emit('savedResources', resources);
    } else {
      socket.emit('error', {
        message: 'No saved resources found'
      });
    }
  }

  /**
   * Handles the startSandboxWithOptions event
   */
private async handleStartSandboxWithOptions(socket: Socket, options: SocketEvents['startSandboxWithOptions']): Promise<void> {
  try {
    printer.log(`Starting sandbox with options: ${JSON.stringify(options)}`, LogLevel.INFO);
    
    // Emit status update to indicate we're starting
    socket.emit('sandboxStatus', { 
      status: 'deploying',
      identifier: options.identifier || this.backendId.name,
      message: 'Starting sandbox...'
    });
    
    // Prepare sandbox options
    const sandboxOptions = {
      dir: options.dirToWatch || './amplify',
      exclude: options.exclude ? options.exclude.split(',') : undefined,
      identifier: options.identifier,
      format: options.outputsFormat as any,
      watchForChanges: !options.once,
      functionStreamingOptions: {
        enabled: options.streamFunctionLogs || false,
        logsFilters: options.logsFilter ? options.logsFilter.split(',') : undefined,
        logsOutFile: options.logsOutFile
      }
    };
    
    // Actually start the sandbox
    await this.sandbox.start(sandboxOptions);
    
    // The sandbox will emit events that update the UI status
    printer.log('Sandbox start command issued successfully', LogLevel.DEBUG);
    
  } catch (error) {
    printer.log(`Error starting sandbox: ${error}`, LogLevel.ERROR);
    socket.emit('sandboxStatus', { 
      status: 'error',
      identifier: options.identifier || this.backendId.name,
      error: `${error}`
    });
  }
}


  /**
   * Handles the stopSandbox event
   */
private async handleStopSandbox(socket: Socket): Promise<void> {
  try {
    printer.log('Stopping sandbox...', LogLevel.INFO);
    
    socket.emit('sandboxStatus', { 
      status: 'stopping',
      identifier: this.backendId.name,
      message: 'Stopping sandbox...'
    });
    
    await this.sandbox.stop();
    
    socket.emit('sandboxStatus', { 
      status: 'stopped',
      identifier: this.backendId.name,
      message: 'Sandbox stopped successfully'
    });
    
    printer.log('Sandbox stopped successfully', LogLevel.INFO);
  } catch (error) {
    printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
    socket.emit('sandboxStatus', { 
      status: 'error',
      identifier: this.backendId.name,
      error: `${error}`
    });
  }
}


  /**
   * Handles the deleteSandbox event
   */
private async handleDeleteSandbox(socket: Socket): Promise<void> {
  try {
    printer.log('Deleting sandbox...', LogLevel.INFO);
    
    socket.emit('sandboxStatus', { 
      status: 'deleting',
      identifier: this.backendId.name,
      message: 'Deleting sandbox...'
    });
    
    await this.sandbox.delete({ identifier: this.backendId.name });
    
    printer.log('Sandbox delete command issued successfully', LogLevel.DEBUG);
  } catch (error) {
    printer.log(`Error deleting sandbox: ${error}`, LogLevel.ERROR);
    socket.emit('sandboxStatus', { 
      status: 'error',
      identifier: this.backendId.name,
      error: `${error}`
    });
  }
}


  /**
   * Handles the stopDevTools event
   */
  private async handleStopDevTools(socket: Socket): Promise<void> {
    await this.shutdownService.shutdown('user request', true);
  }

  /**
   * Extract CloudFormation events from a message
   * @param message The message to extract events from
   * @returns An array of CloudFormation events
   */
  private extractCloudFormationEvents(message: string): string[] {
    const events: string[] = [];
    const lines = message.split('\n');
    
    for (const line of lines) {
      // Match CloudFormation resource status patterns
      if (/\s+[AP]M\s+\|\s+[A-Z_]+\s+\|\s+.+\s+\|\s+.+/.test(line)) {
        events.push(line);
      }
    }
    
    return events;
  }
}
