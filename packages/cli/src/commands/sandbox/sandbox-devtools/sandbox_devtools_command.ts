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
  cleanAnsiCodes,
  extractCloudFormationEvents,
  isDeploymentProgressMessage,
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

    const recentDeploymentMessages = new Set<string>();

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

          sandboxState = state;
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
          LogLevel.INFO,
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

    // Store original printer method
    const originalPrint = printer.print;

    // Flag to prevent duplicate processing of messages
    let processingMessage = false;

    // Function to handle deployment progress messages
    const handleDeploymentProgressMessage = (message: string) => {
      // Clean the message
      const cleanMessage = cleanAnsiCodes(message);

      // Extract CloudFormation events if present
      const cfnEvents = extractCloudFormationEvents(cleanMessage);

      if (cfnEvents.length > 0) {
        // Process each CloudFormation event
        cfnEvents.forEach((event) => {
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

          // Create event object
          const eventObj: DeploymentEventData = {
            message: event,
            timestamp: new Date().toISOString(),
            eventType: 'DEPLOYMENT_PROGRESS',
          };

          // Store the event in the local storage
          storageManager.appendDeploymentProgressEvent(eventObj);

          // Emit the deployment progress event with the actual CloudFormation event
          io.emit('deploymentInProgress', eventObj);
        });
      } else if (
        cleanMessage.includes('_IN_PROGRESS') ||
        cleanMessage.includes('CREATE_') ||
        cleanMessage.includes('DELETE_') ||
        cleanMessage.includes('UPDATE_') ||
        cleanMessage.includes('COMPLETE') ||
        cleanMessage.includes('FAILED')
      ) {
        // This is a deployment status message but not in the standard format

        const messageKey = cleanMessage.trim();

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

        // Create event object
        const eventObj: DeploymentEventData = {
          message: cleanMessage,
          timestamp: new Date().toISOString(),
          eventType: 'DEPLOYMENT_PROGRESS',
        };

        // Store the event in the local storage
        storageManager.appendDeploymentProgressEvent(eventObj);

        // Emit the deployment progress event
        io.emit('deploymentInProgress', eventObj);
      }
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

      // Check if this is a deployment progress message
      if (isDeploymentProgressMessage(cleanMessage)) {
        handleDeploymentProgressMessage(cleanMessage);
      } else {
        // Emit regular messages to client (except DEBUG level)
        // We don't have level info here, so assume INFO
        const logData: LogEventData = {
          timestamp: new Date().toISOString(),
          level: 'INFO',
          message: finalMessage,
        };
        io.emit('log', logData);
      }

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

        // Emit sandbox status update with deletion failure information
        const statusData: SandboxStatusData = {
          status: currentState as SandboxStatus,
          identifier: backendId.name,
          error: true,
          message: `Deletion failed: ${error}`,
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

        // Clear recent deployment messages
        recentDeploymentMessages.clear();

        // Emit sandbox status update with deployment failure information
        const statusData: SandboxStatusData = {
          status: currentState as SandboxStatus,
          identifier: backendId.name,
          error: true,
          message: `Deployment failed: ${error}`,
          timestamp: new Date().toISOString(),
          deploymentCompleted: true,
        };

        // Emit to all connected clients
        io.emit('sandboxStatus', statusData);

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

    // Listen for CloudFormation deployment progress events from the AmplifyIOHost
    io.on('amplifyCloudFormationProgressUpdate', (data) => {
      // Extract CloudFormation events from the message
      const cfnEvents = extractCloudFormationEvents(data.message);

      // Send each event to the client
      cfnEvents.forEach((event) => {
        if (!event) {
          return;
        }
        const eventData: DeploymentEventData = {
          message: event,
          timestamp: new Date().toISOString(),
          eventType: 'DEPLOYMENT_PROGRESS',
        };
        io.emit('deploymentInProgress', eventData);
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

      // No longer automatically send status here
      // The client will explicitly request it with getSandboxStatus
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
