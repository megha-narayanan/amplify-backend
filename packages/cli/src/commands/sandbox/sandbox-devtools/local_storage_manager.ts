import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { LogLevel, printer } from '@aws-amplify/cli-core';

/**
 * Manager for local storage of sandbox data
 * Handles storing and retrieving various types of data like deployment progress, resources, logs, etc.
 */
export class LocalStorageManager {
  private readonly baseDir: string;
  private readonly deploymentProgressFile: string;
  private readonly resourcesFile: string;
  private readonly logsDir: string;
  private readonly cloudWatchLogsDir: string;
  private readonly resourceLoggingStateFile: string;

  /**
   * Creates a new LocalStorageManager
   * @param identifier Optional identifier to separate storage for different sandboxes
   */
  constructor(identifier?: string) {
    // Create a unique directory for this sandbox if identifier is provided
    const dirSuffix = identifier ? `-${identifier}` : '';
    this.baseDir = path.join(tmpdir(), `amplify-devtools${dirSuffix}`);
    this.deploymentProgressFile = path.join(this.baseDir, 'deployment-progress.json');
    this.resourcesFile = path.join(this.baseDir, 'resources.json');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.cloudWatchLogsDir = path.join(this.baseDir, 'cloudwatch-logs');
    this.resourceLoggingStateFile = path.join(this.baseDir, 'resource-logging-states.json');
    
    // Log the storage paths
    printer.log(`LocalStorageManager: Using base directory: ${this.baseDir}`, LogLevel.INFO);
    printer.log(`LocalStorageManager: System temp directory: ${tmpdir()}`, LogLevel.INFO);
    printer.log(`LocalStorageManager: Resources file: ${this.resourcesFile}`, LogLevel.INFO);
    printer.log(`LocalStorageManager: CloudWatch logs directory: ${this.cloudWatchLogsDir}`, LogLevel.INFO);
    
    // Ensure directories exist
    this.ensureDirectories();
  }

  /**
   * Ensures all required directories exist
   */
  private ensureDirectories(): void {
    try {
      printer.log(`LocalStorageManager: Checking if base directory exists: ${this.baseDir}`, LogLevel.INFO);
      if (!fs.existsSync(this.baseDir)) {
        printer.log(`LocalStorageManager: Creating base directory: ${this.baseDir}`, LogLevel.INFO);
        fs.mkdirSync(this.baseDir, { recursive: true });
        printer.log(`LocalStorageManager: Base directory created successfully`, LogLevel.INFO);
      } else {
        printer.log(`LocalStorageManager: Base directory already exists`, LogLevel.INFO);
      }
      
      printer.log(`LocalStorageManager: Checking if logs directory exists: ${this.logsDir}`, LogLevel.INFO);
      if (!fs.existsSync(this.logsDir)) {
        printer.log(`LocalStorageManager: Creating logs directory: ${this.logsDir}`, LogLevel.INFO);
        fs.mkdirSync(this.logsDir, { recursive: true });
        printer.log(`LocalStorageManager: Logs directory created successfully`, LogLevel.INFO);
      } else {
        printer.log(`LocalStorageManager: Logs directory already exists`, LogLevel.INFO);
      }
      
      printer.log(`LocalStorageManager: Checking if CloudWatch logs directory exists: ${this.cloudWatchLogsDir}`, LogLevel.INFO);
      if (!fs.existsSync(this.cloudWatchLogsDir)) {
        printer.log(`LocalStorageManager: Creating CloudWatch logs directory: ${this.cloudWatchLogsDir}`, LogLevel.INFO);
        fs.mkdirSync(this.cloudWatchLogsDir, { recursive: true });
        printer.log(`LocalStorageManager: CloudWatch logs directory created successfully`, LogLevel.INFO);
      } else {
        printer.log(`LocalStorageManager: CloudWatch logs directory already exists`, LogLevel.INFO);
      }
      
      // Test write permissions by creating a test file
      const testFilePath = path.join(this.baseDir, 'test-write-permissions.txt');
      try {
        printer.log(`LocalStorageManager: Testing write permissions with file: ${testFilePath}`, LogLevel.INFO);
        fs.writeFileSync(testFilePath, 'Test write permissions');
        printer.log(`LocalStorageManager: Write permissions test successful`, LogLevel.INFO);
        
        // Clean up test file
        fs.unlinkSync(testFilePath);
        printer.log(`LocalStorageManager: Test file removed`, LogLevel.INFO);
      } catch (writeError) {
        printer.log(`LocalStorageManager: Write permissions test failed: ${writeError}`, LogLevel.ERROR);
      }
    } catch (error) {
      printer.log(`LocalStorageManager: Error creating directories: ${error}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`LocalStorageManager: Error stack: ${error.stack}`, LogLevel.ERROR);
      }
    }
  }

  /**
   * Saves deployment progress events to a file
   * @param events The deployment events to save
   */
  saveDeploymentProgress(events: any[]): void {
    try {
      printer.log(`LocalStorageManager: Saving deployment progress to ${this.deploymentProgressFile}`, LogLevel.INFO);
      printer.log(`LocalStorageManager: Number of events: ${events.length}`, LogLevel.INFO);
      fs.writeFileSync(this.deploymentProgressFile, JSON.stringify(events, null, 2));
      printer.log(`LocalStorageManager: Deployment progress saved successfully`, LogLevel.INFO);
    } catch (error) {
      printer.log(`LocalStorageManager: Error saving deployment progress: ${error}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`LocalStorageManager: Error stack: ${error.stack}`, LogLevel.ERROR);
      }
    }
  }

  /**
   * Loads deployment progress events from a file
   * @returns The saved deployment events or an empty array if none exist
   */
  loadDeploymentProgress(): any[] {
    try {
      printer.log(`LocalStorageManager: Loading deployment progress from ${this.deploymentProgressFile}`, LogLevel.INFO);
      if (fs.existsSync(this.deploymentProgressFile)) {
        printer.log(`LocalStorageManager: Deployment progress file exists`, LogLevel.INFO);
        const data = fs.readFileSync(this.deploymentProgressFile, 'utf8');
        const events = JSON.parse(data);
        printer.log(`LocalStorageManager: Loaded ${events.length} deployment progress events`, LogLevel.INFO);
        return events;
      } else {
        printer.log(`LocalStorageManager: Deployment progress file does not exist`, LogLevel.INFO);
      }
    } catch (error) {
      printer.log(`LocalStorageManager: Error loading deployment progress: ${error}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`LocalStorageManager: Error stack: ${error.stack}`, LogLevel.ERROR);
      }
    }
    return [];
  }

  /**
   * Saves resources to a file
   * @param resources The resources to save
   */
  saveResources(resources: any): void {
    try {
      fs.writeFileSync(this.resourcesFile, JSON.stringify(resources, null, 2));
    } catch (error) {
      console.error('Error saving resources:', error);
    }
  }

  /**
   * Loads resources from a file
   * @returns The saved resources or null if none exist
   */
  loadResources(): any | null {
    try {
      if (fs.existsSync(this.resourcesFile)) {
        const data = fs.readFileSync(this.resourcesFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading resources:', error);
    }
    return null;
  }

  /**
   * Saves console logs to a file
   * @param logs The logs to save
   * @param filename Optional filename, defaults to 'console-logs.json'
   */
  saveConsoleLogs(logs: any[], filename = 'console-logs.json'): void {
    try {
      const filePath = path.join(this.logsDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));
    } catch (error) {
      console.error('Error saving console logs:', error);
    }
  }

  /**
   * Loads console logs from a file
   * @param filename Optional filename, defaults to 'console-logs.json'
   * @returns The saved logs or an empty array if none exist
   */
  loadConsoleLogs(filename = 'console-logs.json'): any[] {
    try {
      const filePath = path.join(this.logsDir, filename);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading console logs:', error);
    }
    return [];
  }

  /**
   * Saves CloudWatch logs for a specific resource
   * @param resourceId The ID of the resource
   * @param logs The logs to save
   */
  saveCloudWatchLogs(resourceId: string, logs: any[]): void {
    try {
      const filePath = path.join(this.cloudWatchLogsDir, `${resourceId}.json`);
      printer.log(`LocalStorageManager: Saving CloudWatch logs for resource ${resourceId} to ${filePath}`, LogLevel.INFO);
      printer.log(`LocalStorageManager: Number of log entries: ${logs.length}`, LogLevel.INFO);
      fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));
      printer.log(`LocalStorageManager: CloudWatch logs saved successfully for resource ${resourceId}`, LogLevel.INFO);
    } catch (error) {
      printer.log(`LocalStorageManager: Error saving CloudWatch logs for resource ${resourceId}: ${error}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`LocalStorageManager: Error stack: ${error.stack}`, LogLevel.ERROR);
      }
    }
  }

  /**
   * Loads CloudWatch logs for a specific resource
   * @param resourceId The ID of the resource
   * @returns The saved logs or an empty array if none exist
   */
  loadCloudWatchLogs(resourceId: string): any[] {
    try {
      const filePath = path.join(this.cloudWatchLogsDir, `${resourceId}.json`);
      printer.log(`LocalStorageManager: Loading CloudWatch logs for resource ${resourceId} from ${filePath}`, LogLevel.INFO);
      if (fs.existsSync(filePath)) {
        printer.log(`LocalStorageManager: CloudWatch logs file exists for resource ${resourceId}`, LogLevel.INFO);
        const data = fs.readFileSync(filePath, 'utf8');
        const logs = JSON.parse(data);
        printer.log(`LocalStorageManager: Loaded ${logs.length} CloudWatch log entries for resource ${resourceId}`, LogLevel.INFO);
        return logs;
      } else {
        printer.log(`LocalStorageManager: CloudWatch logs file does not exist for resource ${resourceId}`, LogLevel.INFO);
      }
    } catch (error) {
      printer.log(`LocalStorageManager: Error loading CloudWatch logs for resource ${resourceId}: ${error}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`LocalStorageManager: Error stack: ${error.stack}`, LogLevel.ERROR);
      }
    }
    return [];
  }

  /**
   * Gets a list of all resources with saved CloudWatch logs
   * @returns Array of resource IDs
   */
  getResourcesWithCloudWatchLogs(): string[] {
    try {
      printer.log(`LocalStorageManager: Getting resources with CloudWatch logs from ${this.cloudWatchLogsDir}`, LogLevel.INFO);
      if (fs.existsSync(this.cloudWatchLogsDir)) {
        printer.log(`LocalStorageManager: CloudWatch logs directory exists`, LogLevel.INFO);
        const files = fs.readdirSync(this.cloudWatchLogsDir);
        printer.log(`LocalStorageManager: Found ${files.length} files in CloudWatch logs directory`, LogLevel.INFO);
        const resourceIds = files
          .filter(file => file.endsWith('.json'))
          .map(file => file.replace('.json', ''));
        printer.log(`LocalStorageManager: Found ${resourceIds.length} resources with CloudWatch logs`, LogLevel.INFO);
        return resourceIds;
      } else {
        printer.log(`LocalStorageManager: CloudWatch logs directory does not exist`, LogLevel.INFO);
      }
    } catch (error) {
      printer.log(`LocalStorageManager: Error getting resources with CloudWatch logs: ${error}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`LocalStorageManager: Error stack: ${error.stack}`, LogLevel.ERROR);
      }
    }
    return [];
  }

  /**
   * Appends a log entry to a resource's CloudWatch logs
   * @param resourceId The ID of the resource
   * @param logEntry The log entry to append
   */
  appendCloudWatchLog(resourceId: string, logEntry: any): void {
    try {
      printer.log(`LocalStorageManager: Appending CloudWatch log for resource ${resourceId}`, LogLevel.INFO);
      const logs = this.loadCloudWatchLogs(resourceId);
      logs.push(logEntry);
      this.saveCloudWatchLogs(resourceId, logs);
      printer.log(`LocalStorageManager: CloudWatch log appended successfully for resource ${resourceId}`, LogLevel.INFO);
    } catch (error) {
      printer.log(`LocalStorageManager: Error appending CloudWatch log for resource ${resourceId}: ${error}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`LocalStorageManager: Error stack: ${error.stack}`, LogLevel.ERROR);
      }
    }
  }

  /**
   * Appends a deployment progress event
   * @param event The event to append
   */
  appendDeploymentProgressEvent(event: any): void {
    try {
      const events = this.loadDeploymentProgress();
      events.push(event);
      this.saveDeploymentProgress(events);
    } catch (error) {
      console.error('Error appending deployment progress event:', error);
    }
  }

  /**
   * Clears all deployment progress events
   */
  clearDeploymentProgress(): void {
    try {
      this.saveDeploymentProgress([]);
    } catch (error) {
      console.error('Error clearing deployment progress:', error);
    }
  }

  /**
   * Clears all stored data
   */
  clearAll(): void {
    try {
      if (fs.existsSync(this.baseDir)) {
        // Remove all files in the base directory
        fs.readdirSync(this.baseDir).forEach(file => {
          const filePath = path.join(this.baseDir, file);
          if (fs.lstatSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
          }
        });

        // Remove all files in the logs directory
        if (fs.existsSync(this.logsDir)) {
          fs.readdirSync(this.logsDir).forEach(file => {
            fs.unlinkSync(path.join(this.logsDir, file));
          });
        }

        // Remove all files in the CloudWatch logs directory
        if (fs.existsSync(this.cloudWatchLogsDir)) {
          fs.readdirSync(this.cloudWatchLogsDir).forEach(file => {
            fs.unlinkSync(path.join(this.cloudWatchLogsDir, file));
          });
        }
      }
    } catch (error) {
      console.error('Error clearing all data:', error);
    }
  }

  /**
   * Saves the logging state for a resource
   * @param resourceId The ID of the resource
   * @param isActive Whether logging is active for this resource
   */
  saveResourceLoggingState(resourceId: string, isActive: boolean): void {
    try {
      // Load existing states
      const loggingStates = this.loadResourceLoggingStates() || {};
      
      // Update the state for this resource
      loggingStates[resourceId] = {
        isActive,
        lastUpdated: new Date().toISOString()
      };
      
      // Save the updated states
      fs.writeFileSync(
        this.resourceLoggingStateFile,
        JSON.stringify(loggingStates, null, 2),
        'utf8'
      );
    } catch (error) {
      console.error(`Error saving resource logging state for ${resourceId}:`, error);
    }
  }

  /**
   * Loads the logging states for all resources
   * @returns Record of resource IDs to their logging state
   */
  loadResourceLoggingStates(): Record<string, { isActive: boolean, lastUpdated: string }> | null {
    try {
      if (fs.existsSync(this.resourceLoggingStateFile)) {
        const content = fs.readFileSync(this.resourceLoggingStateFile, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Error loading resource logging states:', error);
    }
    return null;
  }

  /**
   * Gets the logging state for a specific resource
   * @param resourceId The ID of the resource
   * @returns The logging state or null if not found
   */
  getResourceLoggingState(resourceId: string): { isActive: boolean, lastUpdated: string } | null {
    const states = this.loadResourceLoggingStates();
    return states && states[resourceId] ? states[resourceId] : null;
  }

  /**
   * Gets a list of all resources with active logging
   * @returns Array of resource IDs with active logging
   */
  getResourcesWithActiveLogging(): string[] {
    const states = this.loadResourceLoggingStates();
    if (!states) return [];
    
    return Object.entries(states)
      .filter(([_, state]) => state.isActive)
      .map(([resourceId]) => resourceId);
  }
}
