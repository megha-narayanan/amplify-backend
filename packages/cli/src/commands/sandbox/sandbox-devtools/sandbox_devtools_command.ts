import { CommandModule } from 'yargs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import { LogLevel, format, printer } from '@aws-amplify/cli-core';
import {
  BackendIdentifierConversions,
  PackageJsonReader,
} from '@aws-amplify/platform-core';
import { SandboxSingletonFactory } from '@aws-amplify/sandbox';
import { LocalNamespaceResolver } from '../../../backend-identifier/local_namespace_resolver.js';
import { SDKProfileResolverProvider } from '../../../sdk_profile_resolver_provider.js';
import { SandboxBackendIdResolver } from '../sandbox_id_resolver.js';
import { DeployedBackendClientFactory } from '@aws-amplify/deployed-backend-client';
import { S3Client } from '@aws-sdk/client-s3';
import { AmplifyClient } from '@aws-sdk/client-amplify';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { EOL } from 'os';
import {
  type DeploymentEvent,
  LocalStorageManager,
} from './local_storage_manager.js';
import { ShutdownService } from './services/shutdown_service.js';
import { SocketHandlerService } from './services/socket_handlers.js';
import { ResourceService } from './services/resource_service.js';
import {
  cleanAnsiCodes
} from './logging/cloudformation_format.js';
import { PortChecker } from '../port_checker.js';

/**
 * Type definition for sandbox status
 */
export type SandboxStatus =
  | 'running' // Sandbox is running
  | 'stopped' // Sandbox is stopped
  | 'nonexistent' // Sandbox does not exist
  | 'unknown' // Status is unknown
  | 'deploying' // Sandbox is being deployed
  | 'deleting' // Sandbox is being deleted
  | 'stopping'; // Sandbox is being stopped

/**
 * Type for deployment event objects (extends DeploymentEvent with eventType)
 */
type DeploymentEventData = DeploymentEvent;

/**
 * Type for sandbox status data
 */
type SandboxStatusData = {
  status: SandboxStatus;
  identifier: string;
  error?: boolean;
  message?: string;
  timestamp: string;
  deploymentCompleted?: boolean;
};

/**
 * Type for log event data
 */
type LogEventData = {
  timestamp: string;
  level: string;
  message: string;
};

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
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
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

    // Initialize the backend client
    const backendClient = new DeployedBackendClientFactory().getInstance({
      getS3Client: () => new S3Client(),
      getAmplifyClient: () => new AmplifyClient(),
      getCloudFormationClient: () => new CloudFormationClient(),
    });

    // Get the sandbox instance but don't start it automatically
    const sandboxFactory = new SandboxSingletonFactory(
      sandboxBackendIdResolver.resolve,
      new SDKProfileResolverProvider().resolve,
      printer,
      format,
    );

    const sandbox = await sandboxFactory.getInstance();

    let sandboxState = 'unknown';

    // Function to determine the sandbox state and update related flags
    const getSandboxState = async () => {
      const previousState = sandboxState; // Store the previous state

      // If the state is unknown, check if the stack exists
      if (sandboxState === 'unknown') {
        try {
          // Check AWS stack state
          const cfnClient = new CloudFormationClient();
          const stackName = BackendIdentifierConversions.toStackName(backendId);

          try {
            await cfnClient.send(
              new DescribeStacksCommand({ StackName: stackName }),
            );
            // Stack exists, check sandbox's internal state
            const state = sandbox.getState();
            // If sandbox state is unknown but stack exists, default to stopped
            sandboxState = state === 'unknown' ? 'stopped' : state;
            printer.log(
              `Stack exists, sandbox state is: ${sandboxState}`,
              LogLevel.DEBUG,
            );
          } catch (error) {
            const errorMessage = String(error);
            if (errorMessage.includes('does not exist')) {
              sandboxState = 'nonexistent';
              printer.log(
                'Stack does not exist, setting sandbox state to nonexistent',
                LogLevel.DEBUG,
              );
            } else {
              throw error;
            }
          }
        } catch (error) {
          printer.log(
            `Error checking sandbox status: ${String(error)}`,
            LogLevel.ERROR,
          );
          // Keep state as unknown if there's an error
        }
      } else {
        try {
          const state = sandbox.getState();
          // Only update if we get a definitive state, ignore 'unknown'
          if (state !== 'unknown') {
            sandboxState = state;
          }
          // If state is 'unknown', keep the current sandboxState
        } catch (error) {
          printer.log(
            `Error checking sandbox status: ${String(error)}`,
            LogLevel.ERROR,
          );
          // Don't change the state if there's an error
        }
      }

      // If the state has changed, emit an update to all clients
      if (previousState !== sandboxState) {
        printer.log(
          `Sandbox state changed from ${previousState} to ${sandboxState}, notifying all clients`,
          LogLevel.DEBUG,
        );
        io.emit('sandboxStatus', {
          status: sandboxState as SandboxStatus,
          identifier: backendId.name,
          timestamp: new Date().toISOString(),
        });
      }

      return sandboxState;
    };

    const resourceService = new ResourceService(
      storageManager,
      backendId.name,
      getSandboxState,
      backendId.namespace,
    );

    const shutdownService = new ShutdownService(
      io,
      server,
      storageManager,
      sandbox,
      getSandboxState,
    );

    // Initialize the socket handler service
    const socketHandlerService = new SocketHandlerService(
      io,
      sandbox,
      getSandboxState,
      backendId,
      shutdownService,
      backendClient,
      storageManager,
      resourceService,
    );

    const portChecker = new PortChecker();
    const port = await portChecker.findAvailablePort(server, 3333);

    printer.print(
      `${EOL}DevTools server started at ${format.highlight(`http://localhost:${port}`)}`,
    );
    
    // Open the browser
    const open = (await import('open')).default;
    await open(`http://localhost:${port}`);

    // Log the initial state for debugging
    printer.log(`Initial sandbox state: ${sandboxState}`, LogLevel.DEBUG);

    // Flag to prevent duplicate processing of messages
    let processingMessage = false;
    // Store original printer methods
    const originalPrint = printer.print;
    const originalLog = printer.log;
    let currentLogLevel: LogLevel | null = null;

    // Override printer.log to capture the log level
    printer.log = function (message: string, level?: LogLevel) {
      currentLogLevel = level ? level : LogLevel.DEBUG;
      const result = originalLog.call(this, message, currentLogLevel);
      currentLogLevel = null;
      return result;
    };

    // Override printer.print (the lower-level method)
    printer.print = function (message: string) {
      // Call the original print method
      originalPrint.call(this, message);
      // Avoid double processing if this is called from printer.log
      if (processingMessage) {
        return;
      }

      processingMessage = true;

      const cleanMessage = cleanAnsiCodes(message);

      // Remove timestamp prefix if present (to avoid duplicate timestamps)
      let finalMessage = cleanMessage;
      const timeRegex = /^\d{1,2}:\d{2}:\d{2}\s+[AP]M\s+/;
      if (timeRegex.test(finalMessage)) {
        finalMessage = finalMessage.replace(timeRegex, '');
      }

      
        // Skip DEBUG level messages from being sent to client
        if (currentLogLevel === LogLevel.DEBUG) {
          processingMessage = false;
          return;
        }
        // Emit regular messages to client
        const logData: LogEventData = {
          timestamp: new Date().toISOString(),
          level: LogLevel[currentLogLevel ? currentLogLevel : LogLevel.INFO],
          message: finalMessage,
        };
        io.emit('log', logData);

      processingMessage = false;
    };


    // Listen for resource configuration changes
    sandbox.on('resourceConfigChanged', (data) => {
      printer.log('Resource configuration changed', LogLevel.DEBUG);
      io.emit('resourceConfigChanged', data);
    });

    // Listen for deployment started
    sandbox.on('deploymentStarted', (data) => {
      printer.log('Deployment started', LogLevel.DEBUG);

      sandboxState = 'deploying';

      const statusData: SandboxStatusData = {
        status: 'deploying',
        identifier: backendId.name,
        message: 'Deployment started',
        timestamp: data.timestamp || new Date().toISOString(),
      };

      io.emit('sandboxStatus', statusData);
    });

    sandbox.on('successfulDeployment', () => {
      void (async () => {
        printer.log('Successful deployment detected', LogLevel.DEBUG);

        const currentState = await getSandboxState();

        storageManager.clearResources();

        sandboxState = currentState;

        const statusData: SandboxStatusData = {
          status: sandboxState as SandboxStatus,
          identifier: backendId.name,
          message: 'Deployment completed successfully',
          timestamp: new Date().toISOString(),
          deploymentCompleted: true,
        };
        io.emit('sandboxStatus', statusData);
      })();
    });

    sandbox.on('deletionStarted', (data) => {
      printer.log('Deletion started', LogLevel.DEBUG);

      sandboxState = 'deleting';

      const statusData: SandboxStatusData = {
        status: 'deleting',
        identifier: backendId.name,
        message: 'Deletion started',
        timestamp: data.timestamp || new Date().toISOString(),
      };

      io.emit('sandboxStatus', statusData);
    });

    sandbox.on('successfulDeletion', () => {
      printer.log('Successful deletion detected', LogLevel.DEBUG);

      sandboxState = 'nonexistent';

      const statusData: SandboxStatusData = {
        status: 'nonexistent',
        identifier: backendId.name,
        message: 'Sandbox deleted successfully',
        timestamp: new Date().toISOString(),
        deploymentCompleted: true,
      };

      io.emit('sandboxStatus', statusData);
    });

    sandbox.on('failedDeletion', (error) => {
      void (async () => {
        printer.log('Failed deletion detected', LogLevel.DEBUG);

        // Get the current sandbox state
        const currentState = await getSandboxState();
        sandboxState = currentState; 

        // Emit sandbox status update with deletion failure information
        const statusData: SandboxStatusData = {
          status: currentState as SandboxStatus,
          identifier: backendId.name,
          error: true,
          message: `Deletion failed: ${String(error)}`,
          timestamp: new Date().toISOString(),
          deploymentCompleted: true,
        };

        // Emit to all connected clients
        io.emit('sandboxStatus', statusData);
      })();
    });

    // Listen for failed deployment
    sandbox.on('failedDeployment', (error) => {
      void (async () => {
        printer.log(
          'Failed deployment detected, checking current status',
          LogLevel.DEBUG,
        );

        // Get the current sandbox state
        const currentState = await getSandboxState();
        sandboxState = currentState;
        
        // Emit sandbox status update with deployment failure information
        const statusData: SandboxStatusData = {
          status: currentState as SandboxStatus,
          identifier: backendId.name,
          error: true,
          message: `Deployment failed: ${String(error)}`,
          timestamp: new Date().toISOString(),
          deploymentCompleted: true,
        };

        // Emit to all connected clients
        io.emit('sandboxStatus', statusData);
        
        // Emit deployment error event for enhanced error handling in UI
        io.emit('deploymentError', {
          error: String(error),
          timestamp: new Date().toISOString(),
          recoverable: true
        });

        printer.log(
          `Emitted status '${currentState}' and deployment failure info`,
          LogLevel.DEBUG,
        );
      })();
    });

    // Listen for successful stop
    sandbox.on('successfulStop', () => {
      sandboxState = 'stopped';
      io.emit('sandboxStatus', {
        status: 'stopped',
        identifier: backendId.name,
        message: 'Sandbox stopped successfully',
        timestamp: new Date().toISOString(),
      });
    });

    // Listen for failed stop
    sandbox.on('failedStop', (error) => {
      io.emit('sandboxStatus', {
        status: sandboxState as SandboxStatus,
        identifier: backendId.name,
        error: true,
        message: `Error stopping sandbox: ${String(error)}`,
        timestamp: new Date().toISOString(),
      });
    });


    // Handle socket connections
    io.on('connection', async (socket) => {
      // Get the current sandbox state when a client connects
      const currentState = await getSandboxState();
      printer.log(
        `Client connected, current sandbox state: ${currentState}`,
        LogLevel.DEBUG,
      );

      // Set up all socket event handlers
      socketHandlerService.setupSocketHandlers(socket);
    });

    // Keep the process running until Ctrl+C
    process.once('SIGINT', () => {
      void (async () => {
        await shutdownService.shutdown('SIGINT', true);
      })();
    });

    // Also handle process termination signals
    process.once('SIGTERM', () => {
      void (async () => {
        await shutdownService.shutdown('SIGTERM', true);
      })();
    });
  };
}
