import { CommandModule } from 'yargs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import { LogLevel, format, printer } from '@aws-amplify/cli-core';
import { PackageJsonReader } from '@aws-amplify/platform-core';
import { SandboxSingletonFactory } from '@aws-amplify/sandbox';
import { LocalNamespaceResolver } from '../../../backend-identifier/local_namespace_resolver.js';
import { SDKProfileResolverProvider } from '../../../sdk_profile_resolver_provider.js';
import { SandboxBackendIdResolver } from '../sandbox_id_resolver.js';
import { DeployedBackendClientFactory } from '@aws-amplify/deployed-backend-client';
import { S3Client } from '@aws-sdk/client-s3';
import { AmplifyClient } from '@aws-sdk/client-amplify';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { EOL } from 'os';
import { LocalStorageManager } from './local_storage_manager.js';

// Interface for resource with friendly name
export type ResourceWithFriendlyName = {
  logicalResourceId: string;
  physicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  friendlyName?: string;
};

/**
 * Creates a friendly name for a resource, using CDK metadata when available.
 * @param logicalId The logical ID of the resource
 * @param metadata Optional CDK metadata that may contain construct path
 * @returns A user-friendly name for the resource
 */
export function createFriendlyName(
  logicalId: string,
  metadata?: { constructPath?: string }
): string {
  // If we have CDK metadata with a construct path, use it
  if (metadata?.constructPath) {
    return normalizeCDKConstructPath(metadata.constructPath);
  }
  
  // For CloudFormation stacks, try to extract a friendly name
  if (logicalId.includes('NestedStack') || logicalId.endsWith('StackResource')) {
    const nestedStackName = getFriendlyNameFromNestedStackName(logicalId);
    if (nestedStackName) {
      return nestedStackName;
    }
  }
  
  // Fall back to the basic transformation
  let name = logicalId.replace(/^amplify/, '').replace(/^Amplify/, '');
  name = name.replace(/([A-Z])/g, ' $1').trim();
  name = name.replace(/[0-9A-F]{8}$/, '');
  
  return name || logicalId;
}

/**
 * Normalizes a CDK construct path to create a more readable friendly name
 */
function normalizeCDKConstructPath(constructPath: string): string {
  // Don't process very long paths to avoid performance issues
  if (constructPath.length > 1000) return constructPath;
  
  // Handle nested stack paths
  const nestedStackRegex = /(?<nestedStack>[a-zA-Z0-9_]+)\.NestedStack\/\1\.NestedStackResource$/;
  
  return constructPath
    .replace(nestedStackRegex, '$<nestedStack>')
    .replace('/amplifyAuth/', '/')
    .replace('/amplifyData/', '/');
}

/**
 * Extracts a friendly name from a nested stack logical ID -- not sure if this works?
 */
function getFriendlyNameFromNestedStackName(stackName: string): string | undefined {
  const parts = stackName.split('-');
  
  if (parts && parts.length === 7 && parts[3] === 'sandbox') {
    return parts[5].slice(0, -8) + ' stack';
  } else if (parts && parts.length === 5 && parts[3] === 'sandbox') {
    return 'root stack';
  }
  
  return undefined;
}

/**
 * Finds an available port starting from the given port
 * @param server The HTTP server
 * @param startPort The port to start from
 * @param maxAttempts The maximum number of attempts
 * @returns A promise that resolves when a port is found
 */
export async function findAvailablePort(
  server: ReturnType<typeof createServer>,
  startPort: number,
  maxAttempts: number,
): Promise<number> {
  let port = startPort;
  let attempts = 0;
  let serverStarted = false;

  while (!serverStarted && attempts < maxAttempts) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(port, () => {
          serverStarted = true;
          resolve();
        });

        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            port++;
            attempts++;
            server.close();
            resolve();
          } else {
            reject(err);
          }
        });
      });
    } catch (error) {
      printer.log(`Failed to start server: ${error}`, LogLevel.ERROR);
      throw error;
    }
  }

  if (!serverStarted) {
    throw new Error(
      `Could not find an available port after ${maxAttempts} attempts`,
    );
  }

  return port;
}

/**
 * Clean ANSI escape codes from text
 * @param text The text to clean
 * @returns The cleaned text
 */
function cleanAnsiCodes(text: string): string {
  // This regex handles various ANSI escape sequences including colors, bold, dim, etc.
  return text.replace(/\u001b\[\d+(;\d+)*m|\[2m|\[22m|\[1m|\[36m|\[39m/g, '');
}

/**
 * Check if a message is a deployment progress message
 * @param message The message to check
 * @returns True if the message is a deployment progress message
 */
function isDeploymentProgressMessage(message: string): boolean {
  const cleanedMessage = cleanAnsiCodes(message);
  return (
    cleanedMessage.includes('_IN_PROGRESS') ||
    cleanedMessage.includes('CREATE_') ||
    cleanedMessage.includes('DELETE_') ||
    cleanedMessage.includes('UPDATE_') ||
    cleanedMessage.includes('Deployment in progress') ||
    cleanedMessage.includes('COMPLETE') ||
    cleanedMessage.includes('FAILED') ||
    // Match CloudFormation resource status patterns
    /\d+:\d+:\d+\s+[AP]M\s+\|\s+[A-Z_]+\s+\|\s+.+\s+\|\s+.+/.test(cleanedMessage)
  );
}

/**
 * Check if a message is a CDK deployment log that should be filtered from console
 * @param message The message to check
 * @returns True if the message should be filtered
 */
function shouldFilterFromConsole(message: string): boolean {
  const cleanedMessage = cleanAnsiCodes(message);
  
  // Filter CDK toolkit messages about stack status
  if (cleanedMessage.includes('[deploy: CDK_TOOLKIT_')) {
    return true;
  }
  
  // Filter AWS SDK calls
  if (cleanedMessage.includes('AWS SDK Call')) {
    return true;
  }
  
  // Filter stack progress messages
  if (cleanedMessage.includes('has an ongoing operation in progress and is not stable')) {
    return true;
  }
  
  // Filter detailed deployment progress messages with JSON
  if (cleanedMessage.includes('"deployment":') && 
      cleanedMessage.includes('"event":') && 
      cleanedMessage.includes('"progress":')) {
    return true;
  }
  
  // Filter stack completion messages
  if (cleanedMessage.includes('Stack ARN:') || 
      cleanedMessage.includes('has completed updating')) {
    return true;
  }
  
  // Filter deployment time messages
  if (cleanedMessage.includes('Deployment time:') || 
      cleanedMessage.includes('Total time:')) {
    return true;
  }
  
  return false;
}

/**
 * Extract CloudFormation events from a message
 * @param message The message to extract events from
 * @returns An array of CloudFormation events
 */
function extractCloudFormationEvents(message: string): string[] {
  const events: string[] = [];
  const lines = message.split(EOL);
  
  for (const line of lines) {
    // Match CloudFormation resource status patterns
    if (/\s+[AP]M\s+\|\s+[A-Z_]+\s+\|\s+.+\s+\|\s+.+/.test(line)) {
      events.push(line);
    }
  }
  
  return events;
}

/**
 * Command to start devtools console.
 */
export class SandboxDevToolsCommand implements CommandModule<object> {
  /**
   * @inheritDoc
   */
  readonly command: string;

  /**
   * @inheritDoc
   */
  readonly describe: string;

  /**
   * DevTools command constructor.
   */
  constructor() {
    this.command = 'devtools';
    this.describe = 'Starts a development console for Amplify sandbox';
  }

  /**
   * @inheritDoc
   */
  handler = async (): Promise<void> => {
    const app = express();
    const server = createServer(app);
    const io = new Server(server);

    // Serve static files from the React app's 'dist' directory
    const publicPath = join(
      dirname(fileURLToPath(import.meta.url)),
      './react-app/dist',
    );
    app.use(express.static(publicPath));

    // Apply rate limiting to all routes
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
      legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    });

    // Apply the rate limiting middleware to all requests
    app.use(limiter);

    // For any other request, serve the index.html (for React router)
    app.get('*', (req, res) => {
      res.sendFile(join(publicPath, 'index.html'));
    });

    const sandboxBackendIdResolver = new SandboxBackendIdResolver(
      new LocalNamespaceResolver(new PackageJsonReader()),
    );

    const backendId = await sandboxBackendIdResolver.resolve();
    
    // Create a storage manager for this sandbox
    const storageManager = new LocalStorageManager(backendId.name);

    const backendClient = new DeployedBackendClientFactory().getInstance({
      getS3Client: () => new S3Client(),
      getAmplifyClient: () => new AmplifyClient(),
      getCloudFormationClient: () => new CloudFormationClient(),
    });

    // Function to determine the sandbox state and update related flags
    const getSandboxState = () => {
      try {
        console.log('[DEBUG] Checking sandbox state');
        // Use the sandbox's getState method to get the actual state
        const state = sandbox.getState();
        console.log(`[DEBUG] Sandbox state from getState(): ${state}`);
        
        // Update sandboxState to match actual state
        sandboxState = state;
        
        // If the sandbox is not in 'deploying' state, set deploymentInProgress to false
        if (state !== 'deploying') {
          console.log(`[DEBUG] Sandbox is ${state}, setting deploymentInProgress to false`);
          deploymentInProgress = false;
        }
        
        return state;
      } catch (error) {
        console.log(`[DEBUG] Error checking sandbox status: ${error}`);
        printer.log(`Error checking sandbox status: ${error}`, LogLevel.ERROR);
        return 'unknown';
      }
    };

    // Find an available port starting from 3333
    const port = await findAvailablePort(server, 3333, 10);

    printer.print(
      `${EOL}DevTools server started at ${format.highlight(`http://localhost:${port}`)}`,
    );

    // Open the browser
    const open = (await import('open')).default;
    await open(`http://localhost:${port}`);

    // Override the printer's log and print methods to also emit logs to the client
    const originalLog = printer.log;
    const originalPrint = printer.print;
    
    // Track debug mode state
    let debugModeEnabled = false;
    
    // Track deployment in progress state
    let deploymentInProgress = false;
    
    // Track sandbox state - can be 'running', 'stopped', 'nonexistent', 'deploying', or 'unknown'
    let sandboxState = 'stopped';
    
    // Store recent deployment messages to avoid duplicates
    const recentDeploymentMessages = new Set<string>();
    
    // Function to handle deployment progress messages
    const handleDeploymentProgressMessage = (message: string) => {
      // Clean the message
      const cleanMessage = cleanAnsiCodes(message);
      
      // Extract CloudFormation events if present
      const cfnEvents = extractCloudFormationEvents(cleanMessage);
      
      if (cfnEvents.length > 0) {
        // Process each CloudFormation event
        cfnEvents.forEach(event => {
          // Create a unique key for this event to avoid duplicates
          const eventKey = event.trim();
          
          // Check if we've already sent this exact event recently
          if (recentDeploymentMessages.has(eventKey)) {
            return;
          }
          
          // Add to recent messages and limit size
          recentDeploymentMessages.add(eventKey);
          if (recentDeploymentMessages.size > 100) {
            // Remove oldest message (first item in set)
            const firstValue = recentDeploymentMessages.values().next().value;
            if (firstValue !== undefined) {
              recentDeploymentMessages.delete(firstValue);
            }
          }
          
          // Set deployment in progress flag
          deploymentInProgress = true;
          
          // Create event object
          const eventObj = {
            message: event,
            timestamp: new Date().toISOString()
          };
          
          // Store the event in the local storage
          storageManager.appendDeploymentProgressEvent(eventObj);
          
          // Emit the deployment progress event with the actual CloudFormation event
          io.emit('deploymentInProgress', eventObj);
        });
      } else if (cleanMessage.includes('_IN_PROGRESS') || 
                cleanMessage.includes('CREATE_') || 
                cleanMessage.includes('DELETE_') || 
                cleanMessage.includes('UPDATE_') ||
                cleanMessage.includes('COMPLETE') ||
                cleanMessage.includes('FAILED')) {
        // This is a deployment status message but not in the standard format
        
        // Create a unique key for this message
        const messageKey = cleanMessage.trim();
        
        // Check if we've already sent this exact message recently
        if (recentDeploymentMessages.has(messageKey)) {
          return;
        }
        
        // Add to recent messages and limit size
        recentDeploymentMessages.add(messageKey);
        if (recentDeploymentMessages.size > 100) {
          // Remove oldest message (first item in set)
          const firstValue = recentDeploymentMessages.values().next().value;
          if (firstValue !== undefined) {
            recentDeploymentMessages.delete(firstValue);
          }
        }
        
        // Set deployment in progress flag
        deploymentInProgress = true;
        
        // Create event object
        const eventObj = {
          message: cleanMessage,
          timestamp: new Date().toISOString()
        };
        
        // Store the event in the local storage
        storageManager.appendDeploymentProgressEvent(eventObj);
        
        // Emit the deployment progress event
        io.emit('deploymentInProgress', eventObj);
      }
      
      // Don't log the message again to avoid recursion
    };
    
    // Flag to prevent recursive logging
    let isHandlingLog = false;
    
    // Create a message deduplication cache with a TTL
    const recentLogMessages = new Map<string, number>();
    const MESSAGE_TTL = 1000; // 1 second TTL for duplicate messages
    
    // Function to check if a message is a duplicate
    const isDuplicateMessage = (message: string, level: LogLevel): boolean => {
      const key = `${level}:${message}`;
      const now = Date.now();
      
      // Check if we've seen this message recently
      const lastSeen = recentLogMessages.get(key);
      if (lastSeen && now - lastSeen < MESSAGE_TTL) {
        return true;
      }
      
      // Update the last seen time
      recentLogMessages.set(key, now);
      
      // Clean up old entries
      if (recentLogMessages.size > 100) {
        const keysToDelete = [];
        for (const [mapKey, timestamp] of recentLogMessages.entries()) {
          if (now - timestamp > MESSAGE_TTL) {
            keysToDelete.push(mapKey);
          }
        }
        keysToDelete.forEach(key => recentLogMessages.delete(key));
      }
      
      return false;
    };
    
    printer.log = function(message: string, level: LogLevel = LogLevel.INFO) {
      // Always call the original log method for server-side logging
      originalLog.call(this, message, level);
      
      // Skip DEBUG level messages from being sent to the client
      if (level === LogLevel.DEBUG) {
        return;
      }
      
      // Clean up ANSI color codes and other formatting from the message
      const cleanMessage = cleanAnsiCodes(message);
      
      // Remove timestamp prefix if present (to avoid duplicate timestamps)
      let finalMessage = cleanMessage;
      const timeRegex = /^\d{1,2}:\d{2}:\d{2}\s+[AP]M\s+/;
      if (timeRegex.test(finalMessage)) {
        finalMessage = finalMessage.replace(timeRegex, '');
      }
      
      // Check if this is a deployment progress message and we're not already handling a log
      if (!isHandlingLog && isDeploymentProgressMessage(cleanMessage)) {
        isHandlingLog = true;
        try {
          handleDeploymentProgressMessage(cleanMessage);
        } finally {
          isHandlingLog = false;
        }
      }
      
      // Check for duplicate messages
      if (isDuplicateMessage(finalMessage, level)) {
        return;
      }
      
      // Emit the log to the client (except DEBUG messages)
      io.emit('log', {
        timestamp: new Date().toISOString(),
        level: LogLevel[level], // This correctly maps the enum to string
        message: finalMessage
      });
    };
    
    printer.print = function(message: string) {
      // Call the original print method
      originalPrint.call(this, message);
      
      // Clean up ANSI color codes and other formatting from the message
      const cleanMessage = cleanAnsiCodes(message);
      
      // Skip error messages about deployment in progress
      if (cleanMessage.includes('deployment is in progress') || 
          cleanMessage.includes('Re-run this command once the deployment completes')) {
        return;
      }
      
      // Remove timestamp prefix if present (to avoid duplicate timestamps)
      let finalMessage = cleanMessage;
      const timeRegex = /^\d{1,2}:\d{2}:\d{2}\s+[AP]M\s+/;
      if (timeRegex.test(finalMessage)) {
        finalMessage = finalMessage.replace(timeRegex, '');
      }
      
      // Check if this is a deployment progress message and we're not already handling a log
      if (!isHandlingLog && isDeploymentProgressMessage(cleanMessage)) {
        isHandlingLog = true;
        try {
          handleDeploymentProgressMessage(cleanMessage);
        } finally {
          isHandlingLog = false;
        }
      }
      
      // Emit the log to the client
      io.emit('log', {
        timestamp: new Date().toISOString(),
        level: 'INFO', // print always uses INFO level
        message: finalMessage
      });
    };

    // Get the sandbox instance but don't start it automatically
    const sandboxFactory = new SandboxSingletonFactory(
      sandboxBackendIdResolver.resolve,
      new SDKProfileResolverProvider().resolve,
      printer,
      format,
    );

    const sandbox = await sandboxFactory.getInstance();

    // Get initial sandbox status and set sandboxState
    const initialStatus = getSandboxState();
    printer.log(`DEBUG: Initial sandbox status: ${initialStatus}`, LogLevel.DEBUG);
    sandboxState = initialStatus; // This will update sandboxState to match the actual state

    // Listen for resource configuration changes
    sandbox.on('resourceConfigChanged', async (data) => {
      printer.log('Resource configuration changed', LogLevel.DEBUG);
      io.emit('resourceConfigChanged', data);
    });
    
    // Listen for successful deployment
    sandbox.on('successfulDeployment', () => {
      printer.log('Successful deployment detected', LogLevel.DEBUG);
      
      // Get the current sandbox state
      const currentState = getSandboxState();
      printer.log(`DEBUG: After successful deployment, sandbox state is: ${currentState}`, LogLevel.DEBUG);
      
      // Reset deployment in progress flag
      deploymentInProgress = false;
      
      // Clear recent deployment messages
      recentDeploymentMessages.clear();
      
      // Use the actual sandbox state instead of forcing it to 'running'
      // This ensures we respect the 'stopped' state after a --once deployment
      sandboxState = currentState;
      printer.log(`DEBUG: Using sandbox state '${sandboxState}' after successful deployment`, LogLevel.DEBUG);
      
      // Emit sandbox status update with the actual state and deployment completion info
      const statusData = { 
        status: sandboxState,
        identifier: backendId.name,
        deploymentCompleted: true,
        message: 'Deployment completed successfully',
        timestamp: new Date().toISOString()
      };
      
      // Log the data being sent
      printer.log(`DEBUG: About to emit sandboxStatus event with data: ${JSON.stringify(statusData)}`, LogLevel.DEBUG);
      
      // Emit to all connected clients
      io.emit('sandboxStatus', statusData);
      
      // Also emit to each socket individually to ensure delivery
      io.sockets.sockets.forEach((socket) => {
        printer.log(`DEBUG: Emitting sandboxStatus directly to socket ${socket.id}`, LogLevel.DEBUG);
        socket.emit('sandboxStatus', statusData);
      });
      
      printer.log(`DEBUG: Emitted sandboxStatus event with status '${sandboxState}' and deploymentCompleted flag`, LogLevel.INFO);
    });

    // Listen for failed deployment
    sandbox.on('failedDeployment', (error) => {
      printer.log('Failed deployment detected, checking current status', LogLevel.DEBUG);
      
      // Get the current sandbox state
      const currentState = getSandboxState();
      printer.log(`DEBUG: After failed deployment, sandbox state is: ${currentState}`, LogLevel.DEBUG);
      
      // Reset deployment in progress flag
      deploymentInProgress = false;
      
      // Clear recent deployment messages
      recentDeploymentMessages.clear();
      
      // Emit sandbox status update with deployment failure information
      const statusData = { 
        status: currentState,
        identifier: backendId.name,
        deploymentCompleted: true,
        error: true,
        message: `Deployment failed: ${error}`,
        timestamp: new Date().toISOString()
      };
      
      // Log the data being sent
      printer.log(`DEBUG: About to emit sandboxStatus event with data: ${JSON.stringify(statusData)}`, LogLevel.DEBUG);
      
      // Emit to all connected clients
      io.emit('sandboxStatus', statusData);
      
      // Also emit to each socket individually to ensure delivery
      io.sockets.sockets.forEach((socket) => {
        printer.log(`DEBUG: Emitting sandboxStatus directly to socket ${socket.id}`, LogLevel.DEBUG);
        socket.emit('sandboxStatus', statusData);
      });
      
      printer.log(`DEBUG: Emitted sandboxStatus event with status '${currentState}' and deployment failure info`, LogLevel.INFO);
    });
    
    // Listen for CloudFormation deployment progress events from the AmplifyIOHost
    io.on('AMPLIFY_CFN_PROGRESS_UPDATE', (data) => {
      printer.log(`CloudFormation progress update received on io`, LogLevel.DEBUG);
      // Extract CloudFormation events from the message
      const cfnEvents = extractCloudFormationEvents(data.message);
      
      // Send each event to the client
      cfnEvents.forEach(event => {
        if (event) {
          io.emit('deploymentInProgress', {
            message: event,
            timestamp: new Date().toISOString()
          });
        }
      });
    });

    // Handle socket connections
    io.on('connection', async (socket) => {
      // Send initial sandbox status on connection
      printer.log('New socket connection, getting sandbox status', LogLevel.DEBUG);
      
      // Handle request for saved deployment progress
      socket.on('getSavedDeploymentProgress', () => {
        printer.log('DEBUG: getSavedDeploymentProgress event received', LogLevel.DEBUG);
        const events = storageManager.loadDeploymentProgress();
        socket.emit('savedDeploymentProgress', events);
      });
      
      // Handle request for saved resources
      socket.on('getSavedResources', () => {
        printer.log('DEBUG: getSavedResources event received', LogLevel.DEBUG);
        const resources = storageManager.loadResources();
        if (resources) {
          socket.emit('savedResources', resources);
        } else {
          socket.emit('error', {
            message: 'No saved resources found'
          });
        }
      });
      
      // Handle request for saved resource logs
      socket.on('getSavedResourceLogs', (data: { resourceId: string }) => {
        printer.log(`DEBUG: getSavedResourceLogs event received for ${data.resourceId}`, LogLevel.DEBUG);
        const logs = storageManager.loadCloudWatchLogs(data.resourceId);
        socket.emit('savedResourceLogs', {
          resourceId: data.resourceId,
          logs
        });
      });
      
      // Handle request for active log streams
      socket.on('getActiveLogStreams', () => {
        printer.log('DEBUG: getActiveLogStreams event received', LogLevel.DEBUG);
        const resourceIds = storageManager.getResourcesWithCloudWatchLogs();
        socket.emit('activeLogStreams', resourceIds);
      });
      
      // Map to track active log polling intervals
      const activeLogPollers = new Map<string, NodeJS.Timeout>();
      
      // Handle view resource logs request (without starting/stopping recording)
      socket.on('viewResourceLogs', (data: { resourceId: string }) => {
        printer.log(`DEBUG: viewResourceLogs event received for ${data.resourceId}`, LogLevel.INFO);
        
        try {
          // Load saved logs for this resource
          printer.log(`DEBUG: Loading CloudWatch logs for resource ${data.resourceId}`, LogLevel.INFO);
          const logs = storageManager.loadCloudWatchLogs(data.resourceId);
          printer.log(`DEBUG: Loaded ${logs ? logs.length : 0} CloudWatch logs for resource ${data.resourceId}`, LogLevel.INFO);
          
          // Send logs to client
          printer.log(`DEBUG: Emitting savedResourceLogs event for resource ${data.resourceId}`, LogLevel.INFO);
          socket.emit('savedResourceLogs', {
            resourceId: data.resourceId,
            logs: logs || [] // Ensure we always send an array, even if no logs exist
          });
          printer.log(`DEBUG: Emitted savedResourceLogs event for resource ${data.resourceId}`, LogLevel.INFO);
          
          // Create a dummy log entry if no logs exist, for testing purposes
          if (!logs || logs.length === 0) {
            printer.log(`DEBUG: No logs found for resource ${data.resourceId}, creating dummy log entry`, LogLevel.INFO);
            const dummyLog = {
              timestamp: new Date().toISOString(),
              message: `This is a test log entry for resource ${data.resourceId}`
            };
            
            // Save the dummy log
            storageManager.appendCloudWatchLog(data.resourceId, dummyLog);
            printer.log(`DEBUG: Dummy log entry created and saved for resource ${data.resourceId}`, LogLevel.INFO);
            
            // Send the dummy log to the client
            socket.emit('resourceLogs', {
              resourceId: data.resourceId,
              logs: [dummyLog]
            });
            printer.log(`DEBUG: Emitted resourceLogs event with dummy log for resource ${data.resourceId}`, LogLevel.INFO);
          }
        } catch (error) {
          printer.log(`DEBUG: Error handling viewResourceLogs event for resource ${data.resourceId}: ${error}`, LogLevel.ERROR);
          if (error instanceof Error) {
            printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.ERROR);
          }
          
          // Notify client of error
          socket.emit('logStreamError', {
            resourceId: data.resourceId,
            error: `Error loading logs: ${error}`
          });
        }
      });
      
      
      
      // Handle toggle resource logging request
      socket.on('toggleResourceLogging', async (data: { resourceId: string, resourceType: string, startLogging: boolean }) => {
        printer.log(`DEBUG: toggleResourceLogging event received for ${data.resourceId}, startLogging=${data.startLogging}`, LogLevel.DEBUG);
        
        if (data.startLogging) {
          // Start logging if not already active
          if (!activeLogPollers.has(data.resourceId)) {
            try {
              // Create CloudWatch Logs client
              const cwLogsClient = new CloudWatchLogsClient();
              
              // Check if resource type is defined
              if (!data.resourceType) {
                socket.emit('logStreamError', {
                  resourceId: data.resourceId,
                  error: 'Resource type is undefined. Cannot determine log group.'
                });
                return;
              }
              
              // Determine log group name based on resource type
              let logGroupName: string;
              if (data.resourceType === 'AWS::Lambda::Function') {
                logGroupName = `/aws/lambda/${data.resourceId}`;
              } else if (data.resourceType === 'AWS::ApiGateway::RestApi') {
                logGroupName = `API-Gateway-Execution-Logs_${data.resourceId}`;
              } else if (data.resourceType === 'AWS::AppSync::GraphQLApi') {
                logGroupName = `/aws/appsync/apis/${data.resourceId}`;
              } else {
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
              
              const logStreamName = describeStreamsResponse.logStreams[0].logStreamName;
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
                    logs.forEach(log => {
                      storageManager.appendCloudWatchLog(data.resourceId, log);
                    });
                    
                    // Emit logs to all clients
                    io.emit('resourceLogs', {
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
              activeLogPollers.set(data.resourceId, pollingInterval);
              
              // Notify client that logs are now being recorded
              socket.emit('logStreamStatus', {
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
          const pollingInterval = activeLogPollers.get(data.resourceId);
          if (pollingInterval) {
            // Stop polling
            clearInterval(pollingInterval);
            activeLogPollers.delete(data.resourceId);
            
            // Notify client that logs are no longer being recorded
            socket.emit('logStreamStatus', {
              resourceId: data.resourceId,
              status: 'stopped'
            });
          } else {
            socket.emit('logStreamStatus', {
              resourceId: data.resourceId,
              status: 'not-active'
            });
          }
        }
      });
      
      // Handle explicit sandbox status requests
      socket.on('getSandboxStatus', () => {
        printer.log('getSandboxStatus event received', LogLevel.DEBUG);
        try {
          const status = getSandboxState();
          printer.log(`Emitting sandbox status on request: ${status}`, LogLevel.DEBUG);
          
          socket.emit('sandboxStatus', { 
            status,
            identifier: backendId.name 
          });
        } catch (error) {
          printer.log(`Error getting sandbox status on request: ${error}`, LogLevel.ERROR);
          socket.emit('sandboxStatus', { 
            status: 'unknown', 
            error: `${error}`,
            identifier: backendId.name 
          });
        }
      });
      
      // Handle deployment in progress events from clients
      socket.on('deploymentInProgress', (data) => {
        printer.log(`Deployment in progress: ${data.message}`, LogLevel.INFO);
        // Broadcast to all clients
        io.emit('deploymentInProgress', data);
      });
      
      // Handle CloudFormation deployment progress events
      socket.on('AMPLIFY_CFN_PROGRESS_UPDATE', (data) => {
        printer.log(`CloudFormation progress update received`, LogLevel.DEBUG);
        // Extract CloudFormation events from the message
        const cfnEvents = extractCloudFormationEvents(data.message);
        
        // Send each event to the client
        cfnEvents.forEach(event => {
          if (event) {
            io.emit('deploymentInProgress', {
              message: event,
              timestamp: new Date().toISOString()
            });
          }
        });
      });
      
      // Send the current sandbox state to the client
      printer.log(`Emitting initial sandbox status: ${sandboxState}`, LogLevel.DEBUG);
      printer.log(`Sandbox identifier: ${backendId.name}`, LogLevel.DEBUG);
      socket.emit('sandboxStatus', { 
        status: sandboxState,
        identifier: backendId.name 
      });

      // Handle resource requests
      socket.on('getDeployedBackendResources', async () => {
        try {
          // Try to load saved resources first
          const savedResources = storageManager.loadResources();
          if (savedResources) {
            printer.log('Found saved resources, returning them', LogLevel.INFO);
            const status = getSandboxState();
            socket.emit('deployedBackendResources', {
              ...savedResources,
              status
            });
            return;
          }
          
          try {
            printer.log('Fetching backend metadata...', LogLevel.DEBUG);
            const data = await backendClient.getBackendMetadata(backendId);
            printer.log('Successfully fetched backend metadata', LogLevel.DEBUG);

            // Get the AWS region from the CloudFormation client
            const cfnClient = new CloudFormationClient();
            const regionValue = cfnClient.config.region;

            // Handle different types of region values
            let region = null;

            try {
              if (typeof regionValue === 'function') {
                // If it's an async function, we need to await it
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
            const resourcesWithFriendlyNames = data.resources.map((resource) => {
              const logicalId = resource.logicalResourceId || '';
              let resourceType = resource.resourceType || '';
              
              // Remove CUSTOM:: prefix from resource type
              if (resourceType.startsWith('CUSTOM::')) {
                resourceType = resourceType.substring(8); // Remove "CUSTOM::" (8 characters)
              } else if (resourceType.startsWith('Custom::')) {
                resourceType = resourceType.substring(8); // Remove "Custom::" (8 characters)
              }
              
              // Check if the resource has metadata with a construct path
              // Use a type guard to check if the resource has a metadata property
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
            };
            
            // Save resources to local storage for persistence
            storageManager.saveResources(enhancedData);

            socket.emit('deployedBackendResources', enhancedData);
          } catch (error) {
            const errorMessage = String(error);
            printer.log(
              `Error getting backend resources: ${errorMessage}`,
              LogLevel.ERROR,
            );
            
            // Check if this is a deployment in progress error
            if (errorMessage.includes('deployment is in progress')) {
              socket.emit('deploymentInProgress', {
                message: 'Sandbox deployment is in progress. Resources will update when deployment completes.'
              });
            } else if (errorMessage.includes('does not exist')) {
              // If the stack doesn't exist, return empty resources
              socket.emit('deployedBackendResources', {
                name: backendId.name,
                status: 'nonexistent',
                resources: [],
                region: null,
                message: 'No sandbox exists. Please create a sandbox first.'
              });
            } else {
              // For other errors, emit the error
              socket.emit('error', {
                message: `Failed to get resources: ${errorMessage}`,
              });
            }
          }
        } catch (error) {
          printer.log(
            `Error checking sandbox status: ${error}`,
            LogLevel.ERROR,
          );
          socket.emit('error', {
            message: `Failed to check sandbox status: ${error}`,
          });
        }
      });
      
      // Handle sandbox operations (start, stop, delete)
      socket.on('startSandboxWithOptions', async (options) => {
        try {
          printer.log(`DEBUG: startSandboxWithOptions event received`, LogLevel.INFO);
          
          if (sandboxState !== 'running') {
            printer.log('Starting sandbox with options...', LogLevel.INFO);
            
            // Update sandbox state to deploying
            sandboxState = 'deploying';
            
            io.emit('sandboxStatus', { 
              status: sandboxState,
              identifier: options.identifier || backendId.name
            });
            
            try {
              debugModeEnabled = false;
              
              if (options.debugMode) {
                debugModeEnabled = true;
                printer.log('Debug mode enabled', LogLevel.DEBUG);
              } 
              
              const sandboxOptions = {
                watchForChanges: !options.once,
                identifier: options.identifier,
                dir: options.dirToWatch,
                exclude: options.exclude,
                format: options.outputsFormat,
                functionStreamingOptions: options.streamFunctionLogs ? {
                  enabled: true,
                  logsFilters: options.logsFilter,
                  logsOutFile: options.logsOutFile
                } : undefined
              };
              
              if (options.profile) {
                process.env.AWS_PROFILE = options.profile;
                process.env.AWS_SDK_LOAD_CONFIG = '1';
              }
              
              // Clear any existing deployment state
              deploymentInProgress = false;
              recentDeploymentMessages.clear();
              
              // Emit deployment starting event
              io.emit('deploymentInProgress', {
                message: 'Starting sandbox deployment...',
                timestamp: new Date().toISOString()
              });
              
              await sandbox.start(sandboxOptions);
              
              io.emit('log', {
                timestamp: new Date().toISOString(),
                level: 'SUCCESS',
                message: 'Sandbox started successfully with the specified options'
              });
              
              printer.log('Sandbox started successfully with options', LogLevel.INFO);
            } catch (startError) {
              printer.log(`DEBUG: Error in sandbox.start() with options: ${startError}`, LogLevel.ERROR);
              
              io.emit('log', {
                timestamp: new Date().toISOString(),
                level: 'ERROR',
                message: `Failed to start sandbox with options: ${startError}`
              });
              
              throw startError;
            }
          } else {
            printer.log('Sandbox is already running', LogLevel.INFO);
            io.emit('sandboxStatus', { 
              status: 'running',
              identifier: backendId.name
            });
          }
        } catch (error) {
          printer.log(`Error starting sandbox with options: ${error}`, LogLevel.ERROR);
          io.emit('sandboxStatus', { 
            status: 'stopped', 
            error: `${error}`,
            identifier: options.identifier || backendId.name
          });
        }
      });

      socket.on('stopSandbox', async () => {
        try {
          printer.log('DEBUG: stopSandbox event received from client', LogLevel.DEBUG);
          
          // Log the current sandbox state
          printer.log(`DEBUG: Current sandbox state: ${sandboxState}`, LogLevel.DEBUG);
          
          // Check if sandbox is running using getSandboxState()
          const runningSandboxStatus = getSandboxState();
          printer.log(`DEBUG: getSandboxState() returned: ${runningSandboxStatus}`, LogLevel.DEBUG);
          
          // Log event listeners
          printer.log(`DEBUG: Sandbox event listeners: successfulDeployment=${sandbox.listenerCount('successfulDeployment')}, failedDeployment=${sandbox.listenerCount('failedDeployment')}`, LogLevel.DEBUG);
          
          // Use the actual running status instead of sandboxState
          if (runningSandboxStatus === 'running') {
            printer.log('Stopping sandbox...', LogLevel.DEBUG);
            
            try {
              await sandbox.stop();
              printer.log('sandbox.stop() completed successfully', LogLevel.DEBUG);
              
              // State is updated by sandbox.stop() internally, but we'll get it again to be sure
              const newState = getSandboxState();
              printer.log(`After stop, isSandboxRunning() returned: ${newState}`, LogLevel.DEBUG);
              
              // Notify all clients about the state change
              printer.log(`DEBUG: Broadcasting sandboxStatus event with status '${sandboxState}' to all clients via io.emit`, LogLevel.DEBUG);
              io.emit('sandboxStatus', { 
                status: sandboxState, // sandboxState was updated by isSandboxRunning()
                identifier: backendId.name
              });
              printer.log(`DEBUG: Emitted sandboxStatus event with status '${sandboxState}'`, LogLevel.DEBUG);
              
              printer.log('Sandbox stopped successfully', LogLevel.INFO);
            } catch (stopError) {
              printer.log(`DEBUG: Error in sandbox.stop(): ${stopError}`, LogLevel.ERROR);
              if (stopError instanceof Error && stopError.stack) {
                printer.log(`DEBUG: Error stack: ${stopError.stack}`, LogLevel.DEBUG);
              }
              throw stopError;
            }
          } else {
            printer.log('Sandbox is not running', LogLevel.INFO);
            printer.log(`DEBUG: Not calling sandbox.stop() because isSandboxRunning() returned '${runningSandboxStatus}'`, LogLevel.DEBUG);
            io.emit('sandboxStatus', { 
              status: sandboxState,
              identifier: backendId.name
            });
          }
        } catch (error) {
          printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
          if (error instanceof Error && error.stack) {
            printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
          }
        }
      });
      
      // Handle delete confirmation request
      socket.on('confirmDeleteSandbox', () => {
        // Get the current state directly from the sandbox
        const status = getSandboxState();
        printer.log(`DEBUG: confirmDeleteSandbox - isSandboxRunning() returned: ${status}`, LogLevel.DEBUG);
        
        // Check if the sandbox exists based on its state
        if (status === 'running' || status === 'stopped') {
          // Ask for confirmation
          printer.log('DEBUG: Sandbox exists, requesting confirmation for deletion', LogLevel.DEBUG);
          socket.emit('confirmAction', {
            action: 'deleteSandbox',
            message: 'Are you sure you want to delete this sandbox? All resources will be removed and any data will be lost.',
            title: 'Confirm Sandbox Deletion'
          });
        } else {
          printer.log('DEBUG: Sandbox does not exist, no need for deletion', LogLevel.DEBUG);
          socket.emit('actionResult', {
            action: 'deleteSandbox',
            success: false,
            message: 'No sandbox exists to delete.'
          });
        }
      });
      
      // Handle actual sandbox deletion after confirmation
      socket.on('deleteSandbox', async (confirmed = false) => {
        try {
          printer.log('DEBUG: deleteSandbox event received', LogLevel.DEBUG);
          printer.log(`DEBUG: Confirmation status: ${confirmed}`, LogLevel.DEBUG);
          
          // If not confirmed, request confirmation first
          if (!confirmed) {
            printer.log('DEBUG: Requesting confirmation for sandbox deletion', LogLevel.DEBUG);
            socket.emit('confirmAction', {
              action: 'deleteSandbox',
              message: 'Are you sure you want to delete this sandbox? All resources will be removed and any data will be lost.',
              title: 'Confirm Sandbox Deletion'
            });
            return;
          }
          
          // Log the current sandbox state
          printer.log(`DEBUG: Current sandbox state: ${sandboxState}`, LogLevel.DEBUG);
          
          // Check if sandbox is running using getSandboxState()
          const status = getSandboxState();
          printer.log(`DEBUG: isSandboxRunning() returned: ${status}`, LogLevel.DEBUG);
          
          // Log event listeners
          printer.log(`DEBUG: Sandbox event listeners: successfulDeployment=${sandbox.listenerCount('successfulDeployment')}, failedDeployment=${sandbox.listenerCount('failedDeployment')}`, LogLevel.DEBUG);
          
          // Since isSandboxRunning() returns 'running', 'stopped', or 'unknown',
          // we need to check if the sandbox exists differently
          if (status === 'running' || status === 'stopped') {
            printer.log('Deleting sandbox...', LogLevel.INFO);
            
            printer.log('DEBUG: Updating sandbox status to deploying', LogLevel.DEBUG);
            io.emit('sandboxStatus', { 
              status: 'deploying',
              identifier: backendId.name
            });
            
            // Clear any existing deployment state
            deploymentInProgress = false;
            recentDeploymentMessages.clear();
            printer.log('DEBUG: Cleared deployment state', LogLevel.DEBUG);
            
            // Emit deployment starting event
            io.emit('deploymentInProgress', {
              message: 'Starting sandbox deletion...',
              timestamp: new Date().toISOString()
            });
            printer.log('DEBUG: Emitted deploymentInProgress event', LogLevel.DEBUG);
            
            try {
              if (status === 'running') {
                printer.log('DEBUG: Sandbox is running, stopping it first', LogLevel.DEBUG);
                await sandbox.stop();
                printer.log('DEBUG: sandbox.stop() completed successfully', LogLevel.DEBUG);
              } else {
                printer.log('DEBUG: Sandbox is not running, proceeding with deletion', LogLevel.DEBUG);
              }
              
              printer.log('DEBUG: Calling sandbox.delete()', LogLevel.DEBUG);
              await sandbox.delete({ identifier: backendId.name });
              printer.log('DEBUG: sandbox.delete() completed successfully', LogLevel.DEBUG);
              
              // Update sandbox state
              sandboxState = 'nonexistent';
              printer.log(`DEBUG: Updated sandboxState to '${sandboxState}'`, LogLevel.DEBUG);
              
              // Emit sandbox status update with deployment completion info
              const statusData = { 
                status: 'nonexistent',
                deploymentCompleted: true,
                message: 'Sandbox deleted successfully',
                timestamp: new Date().toISOString()
              };
              
              // Log the data being sent
              printer.log(`DEBUG: About to emit sandboxStatus event with data: ${JSON.stringify(statusData)}`, LogLevel.DEBUG);
              
              // Emit to all connected clients
              io.emit('sandboxStatus', statusData);
              
              // Also emit to each socket individually to ensure delivery
              io.sockets.sockets.forEach((socket) => {
                printer.log(`DEBUG: Emitting sandboxStatus directly to socket ${socket.id}`, LogLevel.DEBUG);
                socket.emit('sandboxStatus', statusData);
              });
              
              printer.log('DEBUG: Emitted sandboxStatus event with status nonexistent and deploymentCompleted flag', LogLevel.DEBUG);
              
              printer.log('Sandbox deleted successfully', LogLevel.INFO);
            } catch (deleteError) {
              printer.log(`DEBUG: Error in sandbox operations: ${deleteError}`, LogLevel.ERROR);
              if (deleteError instanceof Error && deleteError.stack) {
                printer.log(`DEBUG: Error stack: ${deleteError.stack}`, LogLevel.DEBUG);
              }
              throw deleteError;
            }
          } else {
            printer.log('Sandbox does not exist', LogLevel.INFO);
            printer.log('DEBUG: Not calling sandbox.delete() because sandbox does not exist', LogLevel.DEBUG);
            io.emit('sandboxStatus', { 
              status: 'nonexistent'
            });
          }
        } catch (error) {
          printer.log(`Error deleting sandbox: ${error}`, LogLevel.ERROR);
          if (error instanceof Error && error.stack) {
            printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
          }
        }
      });
    });

    // Keep the process running until Ctrl+C
    process.once('SIGINT', async () => {
      printer.print(`${EOL}Stopping the devtools server.`);
      
      // Check if sandbox is running and stop it
      const status = getSandboxState();
      printer.log(`DEBUG: SIGINT handler - isSandboxRunning() returned: ${status}`, LogLevel.DEBUG);
      
      if (status === 'running') {
        printer.log('Stopping sandbox before exiting...', LogLevel.INFO);
        try {
          printer.log('DEBUG: Calling sandbox.stop() from SIGINT handler', LogLevel.DEBUG);
          await sandbox.stop();
          printer.log('Sandbox stopped successfully', LogLevel.INFO);
        } catch (error) {
          printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
          if (error instanceof Error && error.stack) {
            printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
          }
        }
      }
      
      // Clear all stored resources when devtools ends
      printer.log('Clearing stored resources...', LogLevel.DEBUG);
      storageManager.clearAll();
      printer.log('Stored resources cleared', LogLevel.DEBUG);
      
      // Close socket and server connections
      io.close();
      server.close();
    });
    
    // Also handle process termination signals
    process.once('SIGTERM', async () => {
      printer.print(`${EOL}DevTools server is being terminated.`);
      
      // Check if sandbox is running and stop it
      const status = getSandboxState();
      printer.log(`DEBUG: SIGTERM handler - isSandboxRunning() returned: ${status}`, LogLevel.DEBUG);
      
      if (status === 'running') {
        printer.log('Stopping sandbox before exiting...', LogLevel.INFO);
        try {
          printer.log('DEBUG: Calling sandbox.stop() from SIGTERM handler', LogLevel.DEBUG);
          await sandbox.stop();
          printer.log('Sandbox stopped successfully', LogLevel.INFO);
        } catch (error) {
          printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
          if (error instanceof Error && error.stack) {
            printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
          }
        }
      }
      
      // Clear all stored resources when devtools ends
      printer.log('Clearing stored resources...', LogLevel.DEBUG);
      storageManager.clearAll();
      printer.log('Stored resources cleared', LogLevel.DEBUG);
      
      // Close socket and server connections
      io.close();
      server.close();
      process.exit(0);
    });

    // Wait indefinitely
    await new Promise(() => {});
  };
}
