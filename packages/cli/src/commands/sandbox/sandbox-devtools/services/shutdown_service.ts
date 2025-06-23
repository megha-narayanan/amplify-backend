import { LogLevel, printer } from '@aws-amplify/cli-core';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import { LogStreamingService } from './log_streaming_service.js';
import { LocalStorageManager } from '../local_storage_manager.js';

/**
 * Service for handling the shutdown process of the DevTools server
 */
export class ShutdownService {
  private io: Server;
  private server: ReturnType<typeof createServer>;
  private logStreamingService: LogStreamingService;
  private storageManager: LocalStorageManager;
  private sandbox: any; // Using any for now, should be replaced with proper type
  private getSandboxState: () => string;

  /**
   * Creates a new ShutdownService
   * @param io The Socket.IO server
   * @param server The HTTP server
   * @param logStreamingService The log streaming service
   * @param storageManager The local storage manager
   * @param sandbox The sandbox instance
   * @param getSandboxState Function to get the current sandbox state
   */
  constructor(
    io: Server,
    server: ReturnType<typeof createServer>,
    logStreamingService: LogStreamingService,
    storageManager: LocalStorageManager,
    sandbox: any,
    getSandboxState: () => string
  ) {
    this.io = io;
    this.server = server;
    this.logStreamingService = logStreamingService;
    this.storageManager = storageManager;
    this.sandbox = sandbox;
    this.getSandboxState = getSandboxState;
  }

  /**
   * Performs the shutdown process
   * @param reason The reason for shutting down (e.g., 'SIGINT', 'SIGTERM', 'user request')
   * @param exitProcess Whether to exit the process after shutdown
   */
  public async shutdown(reason: string, exitProcess: boolean = false): Promise<void> {
    printer.print(`\nStopping the devtools server (${reason}).`);
    
    // Check if sandbox is running and stop it
    const status = this.getSandboxState();
    printer.log(`${reason} handler - checking sandbox status`, LogLevel.INFO);
    
    if (status === 'running') {
      printer.log('Stopping sandbox before exiting...', LogLevel.INFO);
      try {
        printer.log(`Stopping sandbox from ${reason} handler`, LogLevel.INFO);
        await this.sandbox.stop();
        printer.log('Sandbox stopped successfully', LogLevel.INFO);
      } catch (error) {
        printer.log(`Error stopping sandbox: ${error}`, LogLevel.ERROR);
        if (error instanceof Error && error.stack) {
          printer.log(`DEBUG: Error stack: ${error.stack}`, LogLevel.DEBUG);
        }
      }
    }
    
    // Clean up log streaming resources
    await this.logStreamingService.cleanup();
    
    // Clear all stored resources when devtools ends
    this.storageManager.clearAll();
    
    // Notify clients that the server is shutting down
    this.io.emit('log', {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: `DevTools server is shutting down (${reason})...`
    });
    
    // Close socket and server connections
    this.io.close();
    this.server.close();
    
    // Exit the process if requested
    if (exitProcess) {
      // Short delay to allow messages to be sent
      setTimeout(() => {
        process.exit(0);
      }, 500);
    }
  }
}
