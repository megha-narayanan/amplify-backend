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
import { EOL } from 'os';

// Interface for resource with friendly name
export type ResourceWithFriendlyName = {
  logicalResourceId: string;
  physicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  friendlyName?: string;
};

/**
 * BAD Rudimentary friendly name function.
 * @param logicalId The logical ID of the resource
 * @returns A user-friendly name for the resource
 */
export function createFriendlyName(logicalId: string): string {
  // Remove common prefixes
  let name = logicalId.replace(/^amplify/, '').replace(/^Amplify/, '');

  // Add spaces before capital letters
  name = name.replace(/([A-Z])/g, ' $1').trim();

  // Remove numeric suffixes
  name = name.replace(/[0-9A-F]{8}$/, '');

  // If it's empty after processing, fall back to the original
  return name || logicalId;
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
 * Extract CloudFormation events from a message
 * @param message The message to extract events from
 * @returns An array of CloudFormation events
 */
function extractCloudFormationEvents(message: string): string[] {
  const events: string[] = [];
  const lines = message.split(EOL);
  
  for (const line of lines) {
    // Match CloudFormation resource status patterns
    // Example: "5:25:22 PM | CREATE_IN_PROGRESS | CloudFormation:Stack | root stack"
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

    const backendClient = new DeployedBackendClientFactory().getInstance({
      getS3Client: () => new S3Client(),
      getAmplifyClient: () => new AmplifyClient(),
      getCloudFormationClient: () => new CloudFormationClient(),
    });

    // Function to get the current sandbox status
    const getStatus = async () => {
      try {
        printer.log('Checking sandbox status', LogLevel.DEBUG);
        printer.log('About to call sandbox.getStatus()', LogLevel.DEBUG);
        const status = await sandbox.getStatus();
        printer.log(`Current sandbox status: ${status}`, LogLevel.DEBUG);
        return status;
      } catch (error) {
        printer.log(`Error getting sandbox status: ${error}`, LogLevel.ERROR);
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
    
    // Store recent deployment messages to avoid duplicates
    const recentDeploymentMessages = new Set<string>();
    
    // Function to handle deployment progress messages
    const handleDeploymentProgressMessage = (message: string) => {
      // Clean the message
      const cleanMessage = cleanAnsiCodes(message);
      
      // Check if we've already sent this exact message recently
      if (recentDeploymentMessages.has(cleanMessage)) {
        return;
      }
      
      // Add to recent messages and limit size
      recentDeploymentMessages.add(cleanMessage);
      if (recentDeploymentMessages.size > 100) {
        // Remove oldest message (first item in set)
        const firstValue = recentDeploymentMessages.values().next().value;
        if (firstValue !== undefined) {
          recentDeploymentMessages.delete(firstValue);
        }
      }
      
      // Set deployment in progress flag
      deploymentInProgress = true;
      
      // Emit the deployment progress event
      io.emit('deploymentInProgress', {
        message: cleanMessage,
        timestamp: new Date().toISOString()
      });
      
      // Log the deployment progress message for debugging
      printer.log(`Deployment progress: ${cleanMessage}`, LogLevel.DEBUG);
    };
    
    printer.log = function(message: string, level: LogLevel = LogLevel.INFO) {
      // Skip DEBUG level messages if debug mode is not enabled
      if (level === LogLevel.DEBUG && !debugModeEnabled) {
        // Still call the original log method for server-side logging
        originalLog.call(this, message, level);
        return;
      }
      
      // Call the original log method
      originalLog.call(this, message, level);
      
      // Clean up ANSI color codes and other formatting from the message
      const cleanMessage = cleanAnsiCodes(message);
      
      // Check if this is a deployment progress message
      if (isDeploymentProgressMessage(cleanMessage)) {
        handleDeploymentProgressMessage(cleanMessage);
      }
      
      // Emit the log to the client
      io.emit('log', {
        timestamp: new Date().toISOString(),
        level: LogLevel[level],
        message: cleanMessage
      });
    };
    
    printer.print = function(message: string) {
      // Call the original print method
      originalPrint.call(this, message);
      
      // Clean up ANSI color codes and other formatting from the message
      const cleanMessage = cleanAnsiCodes(message);
      
      // Check if this is a deployment progress message
      if (isDeploymentProgressMessage(cleanMessage)) {
        handleDeploymentProgressMessage(cleanMessage);
      }
      
      // Emit the log to the client
      io.emit('log', {
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: cleanMessage
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

    // Get initial sandbox status
    let initialStatus;
    try {
      initialStatus = await sandbox.getStatus();
    } catch (error) {
      printer.log(`Error getting initial sandbox status: ${error}`, LogLevel.ERROR);
      initialStatus = 'unknown';
    }

    // Listen for resource configuration changes
    sandbox.on('resourceConfigChanged', async (data) => {
      printer.log('Resource configuration changed', LogLevel.DEBUG);
      io.emit('resourceConfigChanged', data);
    });
    
    // Listen for successful deployment
    sandbox.on('successfulDeployment', () => {
      printer.log('Successful deployment detected', LogLevel.DEBUG);
      // Reset deployment in progress flag
      deploymentInProgress = false;
      // Clear recent deployment messages
      recentDeploymentMessages.clear();
      // Emit deployment completed event
      io.emit('deploymentCompleted', {
        timestamp: new Date().toISOString(),
        message: 'Deployment completed successfully'
      });
    });

    // Listen for failed deployment
    sandbox.on('failedDeployment', (error) => {
      printer.log('Failed deployment detected, checking current status', LogLevel.DEBUG);
      // Reset deployment in progress flag
      deploymentInProgress = false;
      // Clear recent deployment messages
      recentDeploymentMessages.clear();
      // Emit deployment failed event
      io.emit('deploymentCompleted', {
        timestamp: new Date().toISOString(),
        message: `Deployment failed: ${error}`,
        error: true
      });
    });
    
    // Listen for sandbox state changes
    sandbox.getStateManager().addListener((status) => {
      printer.log(`Sandbox state changed to: ${status}`, LogLevel.INFO);
      io.emit('sandboxStatus', { 
        status,
        identifier: backendId.name
      });
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
      printer.log('DEBUG: New socket connection, getting sandbox status', LogLevel.DEBUG);
      
      // Handle explicit sandbox status requests
      socket.on('getSandboxStatus', async () => {
        printer.log('DEBUG: getSandboxStatus event received', LogLevel.DEBUG);
        try {
          const status = await getStatus();
          printer.log(`DEBUG: Emitting sandbox status on request: ${status}`, LogLevel.DEBUG);
          
          if (status === 'nonexistent') {
            // For nonexistent sandbox, don't include identifier
            socket.emit('sandboxStatus', { 
              status: 'nonexistent'
            });
          } else {
            // For other statuses, include the identifier
            socket.emit('sandboxStatus', { 
              status,
              identifier: backendId.name 
            });
          }
        } catch (error) {
          printer.log(`DEBUG: Error getting sandbox status on request: ${error}`, LogLevel.ERROR);
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
      
      try {
        const status = await getStatus();
        printer.log(`DEBUG: Emitting initial sandbox status: ${status}`, LogLevel.DEBUG);
        
        if (status === 'nonexistent') {
          // For nonexistent sandbox, don't include identifier
          printer.log('DEBUG: Sandbox does not exist, not including identifier', LogLevel.DEBUG);
          socket.emit('sandboxStatus', { 
            status: 'nonexistent'
          });
        } else {
          // For other statuses, include the identifier
          printer.log(`DEBUG: Sandbox identifier: ${backendId.name}`, LogLevel.DEBUG);
          socket.emit('sandboxStatus', { 
            status,
            identifier: backendId.name 
          });
        }
      } catch (error) {
        printer.log(`DEBUG: Error getting sandbox status on connection: ${error}`, LogLevel.ERROR);
        socket.emit('sandboxStatus', { 
          status: 'unknown', 
          error: `${error}`,
          identifier: backendId.name 
        });
      }

      // Handle resource requests
      socket.on('getDeployedBackendResources', async () => {
        try {
          // First check the sandbox status
          const status = await getStatus();
          
          // If sandbox doesn't exist, return empty resources with a message
          if (status === 'nonexistent') {
            printer.log('No sandbox exists, returning empty resources', LogLevel.INFO);
            socket.emit('deployedBackendResources', {
              name: backendId.name,
              status: 'nonexistent',
              resources: [],
              region: null,
              message: 'No sandbox exists. Please create a sandbox first.'
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
              return {
                ...resource,
                friendlyName: createFriendlyName(logicalId),
              } as ResourceWithFriendlyName;
            });

            // Add region and resources with friendly names to the data
            const enhancedData = {
              ...data,
              region,
              resources: resourcesWithFriendlyNames,
            };

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
          const status = await getStatus();
          
          if (status !== 'running') {
            printer.log('Starting sandbox with options...', LogLevel.INFO);
            io.emit('sandboxStatus', { 
              status: 'deploying',
              identifier: options.identifier || backendId.name
            });
            
            try {
              if (options.debugMode) {
                debugModeEnabled = true;
                printer.log('Debug mode enabled', LogLevel.INFO);
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
          printer.log('DEBUG: stopSandbox event received', LogLevel.DEBUG);
          const status = await getStatus();
          
          if (status === 'running') {
            printer.log('Stopping sandbox...', LogLevel.INFO);
            
            try {
              await sandbox.stop();
              printer.log('Sandbox stopped successfully', LogLevel.INFO);
            } catch (stopError) {
              printer.log(`DEBUG: Error in sandbox.stop(): ${stopError}`, LogLevel.ERROR);
              throw stopError;
            }
          } else {
            printer.log('Sandbox is not running', LogLevel.INFO);
            io.emit('sandboxStatus', { 
              status: 'stopped',
              identifier: backendId.name
            });
          }
        } catch (error) {
          printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
        }
      });
      
      socket.on('deleteSandbox', async () => {
        try {
          printer.log('DEBUG: deleteSandbox event received', LogLevel.DEBUG);
          const status = await getStatus();
          
          if (status !== 'nonexistent') {
            printer.log('Deleting sandbox...', LogLevel.INFO);
            
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
                await sandbox.stop();
              }
              
              await sandbox.delete({ identifier: backendId.name });
              
              io.emit('sandboxStatus', { 
                status: 'nonexistent'
              });
              
              // Emit deployment completed event
              io.emit('deploymentCompleted', {
                timestamp: new Date().toISOString(),
                message: 'Sandbox deleted successfully'
              });
              
              printer.log('Sandbox deleted successfully', LogLevel.INFO);
            } catch (deleteError) {
              printer.log(`DEBUG: Error in sandbox operations: ${deleteError}`, LogLevel.ERROR);
              throw deleteError;
            }
          } else {
            printer.log('Sandbox does not exist', LogLevel.INFO);
            io.emit('sandboxStatus', { 
              status: 'nonexistent'
            });
          }
        } catch (error) {
          printer.log(`Error deleting sandbox: ${error}`, LogLevel.ERROR);
        }
      });
    });

    // Keep the process running until Ctrl+C
    process.once('SIGINT', () => {
      printer.print(`${EOL}Stopping the devtools server.`);
      io.close();
      server.close();
    });

    // Wait indefinitely
    await new Promise(() => {});
  };
}
