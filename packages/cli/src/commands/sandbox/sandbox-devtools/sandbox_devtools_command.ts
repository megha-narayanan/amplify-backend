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
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, PutSubscriptionFilterCommand, DeleteSubscriptionFilterCommand } from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient, CreateFunctionCommand, AddPermissionCommand, GetFunctionCommand } from '@aws-sdk/client-lambda';
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, GetRoleCommand } from '@aws-sdk/client-iam';
import { EOL } from 'os';
import { LocalStorageManager } from './local_storage_manager.js';
import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'os';
import { randomUUID } from 'crypto';
 
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
 * @param metadata.constructPath Optional construct path from CDK metadata
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
 * Attempts to start the server on the specified port
 * @param server The HTTP server
 * @param port The port to use
 * @returns A promise that resolves with the port when the server starts
 * @throws Error if the port is already in use
 */
export async function findAvailablePort(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<number> {
  let serverStarted = false;

  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(port, () => {
        serverStarted = true;
        resolve();
      });

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Please close any applications using this port and try again.`));
        } else {
          reject(err);
        }
      });
    });
  } catch (error) {
    printer.log(`Failed to start server: ${error}`, LogLevel.ERROR);
    throw error;
  }

  if (!serverStarted) {
    throw new Error(`Failed to start server on port ${port}`);
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
   * WebSocket server for real-time log streaming
   */
  private wsServer: WebSocketServer | null = null;

  /**
   * WebSocket server port
   */
  private wsPort: number = 3334; // Different from main server port

  /**
   * ARN of the log forwarder Lambda function
   */
  private logForwarderLambdaArn: string | null = null;

  /**
   * Set of active subscription filters
   */
  private activeSubscriptions = new Set<string>();

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
  /**
   * Creates or gets the IAM role for the log forwarder Lambda
   */
  private async createLogForwarderRole(): Promise<string> {
    const iamClient = new IAMClient();
    const roleName = 'amplify-devtools-log-forwarder-role';
    
    try {
      // Check if role already exists
      const getResponse = await iamClient.send(
        new GetRoleCommand({ RoleName: roleName })
      );
      if (!getResponse.Role?.Arn) {
        throw new Error('Role exists but Arn is undefined');
      }
      return getResponse.Role.Arn;
    } catch (error) {
      // Role doesn't exist, create it
      const createResponse = await iamClient.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: 'lambda.amazonaws.com'
                },
                Action: 'sts:AssumeRole'
              }
            ]
          })
        })
      );
      
      if (!createResponse.Role?.Arn) {
        throw new Error('Failed to create role: Arn is undefined');
      }
      
      // Add permissions policy
      await iamClient.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: 'amplify-devtools-log-forwarder-policy',
          PolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents'
                ],
                Resource: 'arn:aws:logs:*:*:*'
              }
            ]
          })
        })
      );
      
      // Wait for role to propagate
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      return createResponse.Role.Arn;
    }
  }

  /**
   * Creates or gets the log forwarder Lambda function
   */
  private async createLogForwarderLambda(): Promise<string | null> {
    const lambdaClient = new LambdaClient();
    const logForwarderName = 'amplify-devtools-log-forwarder';
    const localIp = await this.getLocalIpAddress();
    
    // If we couldn't find a suitable IP address, we can't create the Lambda function
    if (localIp === null) {
      printer.log(
        'Cannot create log forwarder Lambda function without a valid IP address. ' +
        'Real-time log streaming will not be available.',
        LogLevel.WARN
      );
      return null;
    }
    
    try {
      // Check if Lambda already exists
      const getResponse = await lambdaClient.send(
        new GetFunctionCommand({ FunctionName: logForwarderName })
      );
      
      if (!getResponse.Configuration?.FunctionArn) {
        throw new Error('Lambda function exists but FunctionArn is undefined');
      }
      
      this.logForwarderLambdaArn = getResponse.Configuration.FunctionArn;
      return getResponse.Configuration.FunctionArn;
    } catch (error) {
      // Lambda doesn't exist, create it
      const roleArn = await this.createLogForwarderRole();
      
      const createResponse = await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: logForwarderName,
          Runtime: 'nodejs18.x',
          Role: roleArn,
          Handler: 'index.handler',
          Code: {
            ZipFile: Buffer.from(`
              const https = require('https');
              const http = require('http');
              const WebSocket = require('ws');
              const zlib = require('zlib');
              
              // WebSocket endpoint for your DevTools
              const wsEndpoint = process.env.WEBSOCKET_ENDPOINT;
              
              exports.handler = async (event, context) => {
                // Decode and decompress the CloudWatch Logs data
                const payload = Buffer.from(event.awslogs.data, 'base64');
                const decompressed = zlib.gunzipSync(payload).toString('utf8');
                const logData = JSON.parse(decompressed);
                
                // Extract resource ID from log group name
                const logGroupParts = logData.logGroup.split('/');
                const resourceId = logGroupParts[logGroupParts.length - 1];
                
                // Format log entries
                const logs = logData.logEvents.map(event => ({
                  timestamp: new Date(event.timestamp).toISOString(),
                  message: event.message
                }));
                
                // Send logs to WebSocket if we have any
                if (logs.length > 0 && wsEndpoint) {
                  try {
                    // Use http or https based on the endpoint
                    const ws = new WebSocket(wsEndpoint, {
                      rejectUnauthorized: false // Allow self-signed certs for local dev
                    });
                    
                    await new Promise((resolve, reject) => {
                      ws.on('open', () => {
                        ws.send(JSON.stringify({
                          event: 'resourceLogs',
                          data: {
                            resourceId,
                            logs
                          }
                        }));
                        resolve();
                      });
                      
                      ws.on('error', (error) => {
                        console.error('WebSocket error:', error);
                        reject(error);
                      });
                      
                      // Set a timeout in case connection hangs
                      setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
                    });
                    
                    ws.close();
                    return { statusCode: 200, body: 'Logs sent successfully' };
                  } catch (error) {
                    console.error('Error sending logs to WebSocket:', error);
                    return { statusCode: 500, body: 'Error sending logs' };
                  }
                }
                
                return { statusCode: 200, body: 'No logs to process' };
              };
            `)
          },
          Environment: {
            Variables: {
              WEBSOCKET_ENDPOINT: `ws://${localIp}:${this.wsPort}`
            }
          },
          Timeout: 10 // 10 seconds
        })
      );
      
      // Add permission for CloudWatch Logs to invoke this Lambda
      await lambdaClient.send(
        new AddPermissionCommand({
          FunctionName: logForwarderName,
          StatementId: 'cloudwatch-logs-invoke',
          Action: 'lambda:InvokeFunction',
          Principal: 'logs.amazonaws.com'
        })
      );
      
      if (!createResponse.FunctionArn) {
        throw new Error('Failed to create Lambda function: FunctionArn is undefined');
      }
      
      this.logForwarderLambdaArn = createResponse.FunctionArn;
      return createResponse.FunctionArn;
    }
  }

  /**
   * Gets the local IP address to use for the WebSocket endpoint
   * @returns The local IP address or null if no suitable address is found
   */
  private async getLocalIpAddress(): Promise<string | null> {
    const nets = networkInterfaces();
    
    // Find a non-internal IPv4 address
    for (const name of Object.keys(nets)) {
      if(nets[name]!=undefined){
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal && net.address) {
            return net.address;
          }
        }
      }
    }
    // Return null instead of falling back to localhost
    printer.log(
      'Could not find a suitable network interface for external connections. ' +
      'Real-time log streaming will not be available. ' +
      'Falling back to polling-based logs.',
      LogLevel.WARN
    );
    return null;
  }

  /**
   * Sets up a subscription filter for a log group
   */
  private async setupLogSubscription(logGroupName: string, resourceId: string): Promise<boolean> {
    try {
      // Create or get the Lambda function
      const logForwarderArn = await this.createLogForwarderLambda();
      
      // If we couldn't create the Lambda function, we can't set up the subscription
      if (logForwarderArn === null) {
        printer.log(
          `Cannot set up log subscription for ${resourceId} without a valid Lambda function. ` +
          'Falling back to polling-based logs.',
          LogLevel.WARN
        );
        return false;
      }
      
      // Create a unique filter name for this resource
      const filterName = `amplify-devtools-${resourceId}-${randomUUID().substring(0, 8)}`;
      
      // Create a subscription filter
      const cwLogsClient = new CloudWatchLogsClient();
      await cwLogsClient.send(
        new PutSubscriptionFilterCommand({
          logGroupName,
          filterName,
          filterPattern: '', // Match all logs
          destinationArn: logForwarderArn
        })
      );
      
      // Store the active subscription
      this.activeSubscriptions.add(`${logGroupName}:${filterName}`);
      
      printer.log(`Set up log subscription for ${resourceId}`, LogLevel.INFO);
      return true;
    } catch (error) {
      printer.log(`Error setting up log subscription: ${error}`, LogLevel.ERROR);
      return false;
    }
  }

  /**
   * Removes a subscription filter for a log group
   */
  private async removeLogSubscription(logGroupName: string, resourceId: string): Promise<boolean> {
    try {
      const cwLogsClient = new CloudWatchLogsClient();
      
      // Find the filter name for this resource
      const filterPrefix = `amplify-devtools-${resourceId}`;
      let filterToRemove = null;
      
      for (const subscription of this.activeSubscriptions) {
        const [group, filter] = subscription.split(':');
        if (group === logGroupName && filter.startsWith(filterPrefix)) {
          filterToRemove = filter;
          break;
        }
      }
      
      if (!filterToRemove) {
        printer.log(`No active subscription found for ${resourceId}`, LogLevel.INFO);
        return false;
      }
      
      // Delete the subscription filter
      await cwLogsClient.send(
        new DeleteSubscriptionFilterCommand({
          logGroupName,
          filterName: filterToRemove
        })
      );
      
      // Remove from active subscriptions
      this.activeSubscriptions.delete(`${logGroupName}:${filterToRemove}`);
      
      printer.log(`Removed log subscription for ${resourceId}`, LogLevel.INFO);
      return true;
    } catch (error) {
      printer.log(`Error removing log subscription: ${error}`, LogLevel.ERROR);
      return false;
    }
  }

  handler = async (): Promise<void> => {
    const app = express();
    const server = createServer(app);
    const io = new Server(server);
    
    // Create WebSocket server for real-time log streaming
    const wsServer = new WebSocketServer({ port: this.wsPort });
    this.wsServer = wsServer;
    
    printer.log(`WebSocket server for log streaming started on port ${this.wsPort}`, LogLevel.INFO);
    
    // Handle WebSocket connections
    wsServer.on('connection', (ws) => {
      printer.log('Log streaming WebSocket client connected', LogLevel.DEBUG);
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          // If this is a log message from our Lambda
          if (data.event === 'resourceLogs' && data.data) {
            // Forward to all Socket.IO clients
            io.emit('resourceLogs', data.data);
            
            // Save logs to local storage
            if (data.data.resourceId && data.data.logs) {
              data.data.logs.forEach((log: { timestamp: string; message: string }) => {
                storageManager.appendCloudWatchLog(data.data.resourceId, log);
              });
            }
          }
        } catch (error) {
          printer.log(`Error processing WebSocket message: ${error}`, LogLevel.ERROR);
        }
      });
      
      ws.on('close', () => {
        printer.log('Log streaming WebSocket client disconnected', LogLevel.DEBUG);
      });
    });

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
          // Use the sandbox's getState method to get the actual state
          const state = sandbox.getState();
          
          // Update sandboxState to match actual state
          sandboxState = state;
          
          // If the sandbox is not in 'deploying' state, set deploymentInProgress to false
          if (state !== 'deploying') {
            deploymentInProgress = false;
          }
          
          return state;
        } catch (error) {
          printer.log(`Error checking sandbox status: ${error}`, LogLevel.ERROR);
          return 'unknown';
        }
      };

    // Find an available port starting from 3333
    const port = await findAvailablePort(server, 3333);

    printer.print(
      `${EOL}DevTools server started at ${format.highlight(`http://localhost:${port}`)}`,
    );

    // Open the browser
    const open = (await import('open')).default;
    await open(`http://localhost:${port}`);

    // Track debug mode state (used when options.debugMode is true)
    let debugModeEnabled = false;
    
    // Track deployment in progress state (used to update UI state)
    let deploymentInProgress = false;
    
    // Track sandbox state - can be 'running', 'stopped', 'nonexistent', 'deploying', or 'unknown'
    let sandboxState = 'unknown';
    
    // Store recent deployment messages to avoid duplicates
    const recentDeploymentMessages = new Set<string>();
    
    // Store original printer methods
    const originalPrint = printer.print;
    
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
    

    // Track the original log level of messages
    const messageLogLevels = new Map<string, LogLevel>();
    
    // Override the original log function to track log levels
    const originalLog = printer.log;
    printer.log = function(message: string, level: LogLevel = LogLevel.INFO) {
      // Store the log level for this message
      messageLogLevels.set(message, level);
      
      // Call the original log method with tracking
      originalLog.call(this, message, level);
      
      // Clean up the map after a delay to prevent memory leaks
      setTimeout(() => {
        messageLogLevels.delete(message);
      }, 5000); // Clean up after 5 seconds
      
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
      
      // Emit the log to the client (except DEBUG messages)
      io.emit('log', {
        timestamp: new Date().toISOString(),
        level: LogLevel[level],
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
      
      // Check if this message was originally logged with a specific level
      // If it was logged with DEBUG level, don't send it to the UI
      for (const [originalMsg, level] of messageLogLevels.entries()) {
        if (message.includes(originalMsg) && level === LogLevel.DEBUG) {
          return; // Skip sending DEBUG messages to the UI
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
        // Use getResourcesWithActiveLogging instead of getResourcesWithCloudWatchLogs
        // to only return resources that are actively being logged
        const resourceIds = storageManager.getResourcesWithActiveLogging();
        printer.log(`DEBUG: Active log streams: ${resourceIds.join(', ') || 'none'}`, LogLevel.DEBUG);
        socket.emit('activeLogStreams', resourceIds);
      });
      
      // Handle request for log settings
      socket.on('getLogSettings', () => {
        printer.log('DEBUG: getLogSettings event received', LogLevel.DEBUG);
        // Get current log size
        const currentSizeMB = storageManager.getLogsSizeInMB();
        
        socket.emit('logSettings', { 
          maxLogSizeMB: storageManager.maxLogSizeMB || 50,
          currentSizeMB
        });
      });
      
      // Handle save log settings request
      socket.on('saveLogSettings', (settings) => {
        printer.log(`DEBUG: saveLogSettings event received: ${JSON.stringify(settings)}`, LogLevel.DEBUG);
        if (settings && typeof settings.maxLogSizeMB === 'number') {
          storageManager.setMaxLogSize(settings.maxLogSizeMB);
          
          // Get updated log size
          const currentSizeMB = storageManager.getLogsSizeInMB();
          
          // Broadcast the updated settings to all clients
          io.emit('logSettings', { 
            maxLogSizeMB: settings.maxLogSizeMB,
            currentSizeMB
          });
          
          printer.log(`Log settings updated: Max size set to ${settings.maxLogSizeMB} MB`, LogLevel.INFO);
        }
      });
      
      // Handle request for custom friendly names
      socket.on('getCustomFriendlyNames', () => {
        printer.log('DEBUG: getCustomFriendlyNames event received', LogLevel.DEBUG);
        const friendlyNames = storageManager.loadCustomFriendlyNames();
        socket.emit('customFriendlyNames', friendlyNames);
      });
      
      // Handle update custom friendly name request
      socket.on('updateCustomFriendlyName', (data: { resourceId: string; friendlyName: string }) => {
        printer.log(`DEBUG: updateCustomFriendlyName event received for ${data.resourceId}: ${data.friendlyName}`, LogLevel.DEBUG);
        if (data && data.resourceId && data.friendlyName) {
          storageManager.updateCustomFriendlyName(data.resourceId, data.friendlyName);
          
          // Broadcast the updated friendly name to all clients
          io.emit('customFriendlyNameUpdated', { 
            resourceId: data.resourceId,
            friendlyName: data.friendlyName
          });
          
          printer.log(`Custom friendly name updated for ${data.resourceId}: ${data.friendlyName}`, LogLevel.INFO);
        }
      });
      
      // Handle remove custom friendly name request
      socket.on('removeCustomFriendlyName', (data: { resourceId: string }) => {
        printer.log(`DEBUG: removeCustomFriendlyName event received for ${data.resourceId}`, LogLevel.DEBUG);
        if (data && data.resourceId) {
          storageManager.removeCustomFriendlyName(data.resourceId);
          
          // Broadcast the removal to all clients
          io.emit('customFriendlyNameRemoved', { 
            resourceId: data.resourceId
          });
          
          printer.log(`Custom friendly name removed for ${data.resourceId}`, LogLevel.INFO);
        }
      });
      
      // Map to track active log polling intervals
      const activeLogPollers = new Map<string, NodeJS.Timeout>();
      
      // Handle view resource logs request (without starting/stopping recording)
      socket.on('viewResourceLogs', (data: { resourceId: string }) => {
        printer.log(`Viewing logs for resource ${data.resourceId}`, LogLevel.DEBUG);
        
        try {
          // Load saved logs for this resource
          const logs = storageManager.loadCloudWatchLogs(data.resourceId);
          
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
      });
      
      
      
      // Handle toggle resource logging request
      socket.on('toggleResourceLogging', async (data: { resourceId: string, resourceType: string, startLogging: boolean }) => {
        printer.log(`Toggle logging for ${data.resourceId}, startLogging=${data.startLogging}`, LogLevel.DEBUG);
        
        if (data.startLogging) {
          // Start logging if not already active
          // eslint-disable-next-line spellcheck/spell-checker
          if (!activeLogPollers.has(data.resourceId)) {
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
              let logGroupName: string;
              if (data.resourceType === 'AWS::Lambda::Function') {
                logGroupName = `/aws/lambda/${data.resourceId}`;
              } else if (data.resourceType === 'AWS::ApiGateway::RestApi') {
                logGroupName = `API-Gateway-Execution-Logs_${data.resourceId}`;
              } else if (data.resourceType === 'AWS::AppSync::GraphQLApi') {
                // eslint-disable-next-line spellcheck/spell-checker
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
              
              // Try to set up real-time log streaming first
              const subscriptionSuccess = await this.setupLogSubscription(logGroupName, data.resourceId);
              
              if (subscriptionSuccess) {
                // Real-time log streaming set up successfully
                printer.log(`Real-time log streaming set up for ${data.resourceId}`, LogLevel.INFO);
                
                // Save the logging state to local storage
                storageManager.saveResourceLoggingState(data.resourceId, true);
                
                // Notify client that logs are now being recorded
                socket.emit('logStreamStatus', {
                  resourceId: data.resourceId,
                  status: 'active'
                });
                
                // Also broadcast to all clients to ensure UI is updated everywhere
                io.emit('logStreamStatus', {
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
              
              // Save the logging state to local storage
              storageManager.saveResourceLoggingState(data.resourceId, true);
              
              // Notify client that logs are now being recorded
              socket.emit('logStreamStatus', {
                resourceId: data.resourceId,
                status: 'active'
              });
              
              // Also broadcast to all clients to ensure UI is updated everywhere
              io.emit('logStreamStatus', {
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
          
          // Determine log group name based on resource type
          let logGroupName: string;
          if (data.resourceType === 'AWS::Lambda::Function') {
            logGroupName = `/aws/lambda/${data.resourceId}`;
          } else if (data.resourceType === 'AWS::ApiGateway::RestApi') {
            logGroupName = `API-Gateway-Execution-Logs_${data.resourceId}`;
          } else if (data.resourceType === 'AWS::AppSync::GraphQLApi') {
            // eslint-disable-next-line spellcheck/spell-checker
            logGroupName = `/aws/appsync/apis/${data.resourceId}`;
          } else {
            socket.emit('logStreamError', {
              resourceId: data.resourceId,
              error: `Unsupported resource type for logs: ${data.resourceType}`
            });
            return;
          }
          
          // Try to remove subscription filter if it exists
          await this.removeLogSubscription(logGroupName, data.resourceId);
          
          if (pollingInterval) {
            // Stop polling
            clearInterval(pollingInterval);
            activeLogPollers.delete(data.resourceId);
            
            printer.log(`Stopped log polling for resource ${data.resourceId}`, LogLevel.INFO);
          }
          
          // Save the logging state to local storage
          printer.log(`DEBUG: Saving inactive logging state for resource ${data.resourceId}`, LogLevel.DEBUG);
          storageManager.saveResourceLoggingState(data.resourceId, false);
          
          // Notify client that logs are no longer being recorded
          socket.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'stopped'
          });
          
          // Also broadcast to all clients to ensure UI is updated everywhere
          io.emit('logStreamStatus', {
            resourceId: data.resourceId,
            status: 'stopped'
          });
          
          printer.log(`Stopped logging for resource ${data.resourceId}`, LogLevel.INFO);
        }
      });
      
      // Handle explicit sandbox status requests
      socket.on('getSandboxStatus', () => {
        try {
          const status = getSandboxState();
          
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
          printer.log(`startSandboxWithOptions event received`, LogLevel.INFO);
          
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
                message: 'Sandbox started successfully'
              });
              
              printer.log('Sandbox started successfully', LogLevel.INFO);
            } catch (startError) {
              printer.log(`Error in sandbox.start() with options: ${startError}`, LogLevel.ERROR);
              
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
          printer.log('stopSandbox event received from client', LogLevel.INFO);
          
          // Check if sandbox is running using getSandboxState()
          const runningSandboxStatus = getSandboxState();
          
          // Use the actual running status instead of sandboxState
          if (runningSandboxStatus === 'running') {
            printer.log('Stopping sandbox...', LogLevel.INFO);
            
            try {
              await sandbox.stop();
              // Notify all clients about the state change
              io.emit('sandboxStatus', { 
                status: getSandboxState(), 
                identifier: backendId.name
              });
              
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
            printer.log(`Not calling sandbox.stop() because sandbox is not running`, LogLevel.INFO);
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
      // Handle sandbox deletion (client-side confirmation is already handled)
      socket.on('deleteSandbox', async () => {
        try {
          printer.log('deleteSandbox event received', LogLevel.INFO);
          
          // Check if sandbox is running using getSandboxState()
          const status = getSandboxState();
          
          // Since isSandboxRunning() returns 'running', 'stopped', or 'unknown',
          // we need to check if the sandbox exists differently
          if (status === 'running' || status === 'stopped') {
            printer.log('Deleting sandbox...', LogLevel.INFO);
            
            // Update sandbox status to deploying
            io.emit('sandboxStatus', { 
              status: 'deploying',
              identifier: backendId.name
            });
            
            // Clear any existing deployment state
            deploymentInProgress = false;
            recentDeploymentMessages.clear();
            
            // Emit deployment starting event
            io.emit('deploymentInProgress', {
              message: 'Starting sandbox deletion...',
              timestamp: new Date().toISOString()
            });
            
            try {
              if (status === 'running') {
                printer.log('Sandbox is running, stopping it first', LogLevel.INFO);
                await sandbox.stop();
              }
              
              await sandbox.delete({ identifier: backendId.name });
              
              // Update sandbox state
              sandboxState = 'nonexistent';
              
              // Emit sandbox status update with deployment completion info
              const statusData = { 
                status: 'nonexistent',
                deploymentCompleted: true,
                message: 'Sandbox deleted successfully',
                timestamp: new Date().toISOString()
              };
              
              // Emit to all connected clients
              io.emit('sandboxStatus', statusData);
              
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
            printer.log('Not calling sandbox.delete() because sandbox does not exist', LogLevel.INFO);
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

      // Handle stopDevTools event from client
      socket.on('stopDevTools', async () => {
        printer.print(`${EOL}Stopping the devtools server by client request.`);
        
        // Check if sandbox is running and stop it
        const status = getSandboxState();
        printer.log(`stopDevTools handler - checking sandbox status`, LogLevel.INFO);
        
        if (status === 'running') {
          printer.log('Stopping sandbox before exiting...', LogLevel.INFO);
          try {
            printer.log('Stopping sandbox from stopDevTools handler', LogLevel.INFO);
            await sandbox.stop();
            printer.log('Sandbox stopped successfully', LogLevel.INFO);
          } catch (error) {
            printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
            if (error instanceof Error && error.stack) {
              printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
            }
          }
        }
        
        // Clean up WebSocket server
        if (this.wsServer) {
          printer.log('Closing WebSocket server', LogLevel.INFO);
          this.wsServer.close();
          this.wsServer = null;
        }
        
        // Clean up any active subscription filters
        if (this.activeSubscriptions.size > 0) {
          printer.log(`Cleaning up ${this.activeSubscriptions.size} active subscription filters`, LogLevel.INFO);
          for (const subscription of this.activeSubscriptions) {
            const [logGroupName, filterName] = subscription.split(':');
            try {
              const cwLogsClient = new CloudWatchLogsClient();
              await cwLogsClient.send(
                new DeleteSubscriptionFilterCommand({
                  logGroupName,
                  filterName
                })
              );
              printer.log(`Removed subscription filter ${filterName} from ${logGroupName}`, LogLevel.DEBUG);
            } catch (error) {
              printer.log(`Error removing subscription filter: ${error}`, LogLevel.ERROR);
            }
          }
          this.activeSubscriptions.clear();
        }
        
        // Clear all stored resources when devtools ends
        storageManager.clearAll();
        
        // Notify clients that the server is shutting down
        io.emit('log', {
          timestamp: new Date().toISOString(),
          level: 'INFO',
          message: 'DevTools server is shutting down by user request...'
        });
        
        // Close socket and server connections
        io.close();
        server.close();
        
        // Exit the process after a short delay to allow the message to be sent
        setTimeout(() => {
          process.exit(0);
        }, 500);
      });
    });

    // Keep the process running until Ctrl+C
    process.once('SIGINT', async () => {
      printer.print(`${EOL}Stopping the devtools server.`);
      
      // Check if sandbox is running and stop it
      const status = getSandboxState();
      printer.log(`SIGINT handler - checking sandbox status`, LogLevel.INFO);
      
      if (status === 'running') {
        printer.log('Stopping sandbox before exiting...', LogLevel.INFO);
        try {
          printer.log('Stopping sandbox from SIGINT handler', LogLevel.INFO);
          await sandbox.stop();
          printer.log('Sandbox stopped successfully', LogLevel.INFO);
        } catch (error) {
          printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
          if (error instanceof Error && error.stack) {
            printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
          }
        }
      }
      
      // Clean up WebSocket server
      if (this.wsServer) {
        printer.log('Closing WebSocket server', LogLevel.INFO);
        this.wsServer.close();
        this.wsServer = null;
      }
      
      // Clean up any active subscription filters
      if (this.activeSubscriptions.size > 0) {
        printer.log(`Cleaning up ${this.activeSubscriptions.size} active subscription filters`, LogLevel.INFO);
        for (const subscription of this.activeSubscriptions) {
          const [logGroupName, filterName] = subscription.split(':');
          try {
            const cwLogsClient = new CloudWatchLogsClient();
            await cwLogsClient.send(
              new DeleteSubscriptionFilterCommand({
                logGroupName,
                filterName
              })
            );
            printer.log(`Removed subscription filter ${filterName} from ${logGroupName}`, LogLevel.DEBUG);
          } catch (error) {
            printer.log(`Error removing subscription filter: ${error}`, LogLevel.ERROR);
          }
        }
        this.activeSubscriptions.clear();
      }
      
      // Clear all stored resources when devtools ends
      storageManager.clearAll();
      
      // Close socket and server connections
      io.close();
      server.close();
    });
    
    // Also handle process termination signals
    process.once('SIGTERM', async () => {
      printer.print(`${EOL}DevTools server is being terminated.`);
      
      // Check if sandbox is running and stop it
      const status = getSandboxState();
      printer.log(`SIGTERM handler - checking sandbox status`, LogLevel.INFO);
      
      if (status === 'running') {
        printer.log('Stopping sandbox before exiting...', LogLevel.INFO);
        try {
          printer.log('Stopping sandbox from SIGTERM handler', LogLevel.INFO);
          await sandbox.stop();
          printer.log('Sandbox stopped successfully', LogLevel.INFO);
        } catch (error) {
          printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
          if (error instanceof Error && error.stack) {
            printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
          }
        }
      }
      
      // Clean up WebSocket server
      if (this.wsServer) {
        printer.log('Closing WebSocket server', LogLevel.INFO);
        this.wsServer.close();
        this.wsServer = null;
      }
      
      // Clean up any active subscription filters
      if (this.activeSubscriptions.size > 0) {
        printer.log(`Cleaning up ${this.activeSubscriptions.size} active subscription filters`, LogLevel.INFO);
        for (const subscription of this.activeSubscriptions) {
          const [logGroupName, filterName] = subscription.split(':');
          try {
            const cwLogsClient = new CloudWatchLogsClient();
            await cwLogsClient.send(
              new DeleteSubscriptionFilterCommand({
                logGroupName,
                filterName
              })
            );
            printer.log(`Removed subscription filter ${filterName} from ${logGroupName}`, LogLevel.DEBUG);
          } catch (error) {
            printer.log(`Error removing subscription filter: ${error}`, LogLevel.ERROR);
          }
        }
        this.activeSubscriptions.clear();
      }
      
      // Clear all stored resources when devtools ends
      storageManager.clearAll();
      
      // Close socket and server connections
      io.close();
      server.close();
      process.exit(0);
    });

    // Wait indefinitely
    await new Promise(() => {});
  };
}
