/**
 * Creates a friendly name for a resource, using CDK metadata when available.
 * @param logicalId The logical ID of the resource
 * @param metadata Optional CDK metadata that may contain construct path
 * @param metadata.constructPath Optional construct path from CDK metadata
 * @returns A user-friendly name for the resource
 */
export const createFriendlyName = (
  logicalId: string,
  metadata?: { constructPath?: string },
): string => {
  // If we have CDK metadata with a construct path, use it
  if (metadata?.constructPath) {
    return normalizeCDKConstructPath(metadata.constructPath);
  }

  // For CloudFormation stacks, try to extract a friendly name
  if (
    logicalId.includes('NestedStack') ||
    logicalId.endsWith('StackResource')
  ) {
    const nestedStackName = getFriendlyNameFromNestedStackName(logicalId);
    if (nestedStackName) {
      return nestedStackName;
    }
  }

  // Fall back to the basic transformation
  let name = logicalId.replace(/^amplify/, '').replace(/^Amplify/, '');
  name = name.replace(/([A-Z])/g, ' $1').trim();
  name = name.replace(/[0-9]+[A-Z]*[0-9]*/, '');

  return name || logicalId;
};

/**
 * Normalizes a CDK construct path to create a more readable friendly name
 * @param constructPath The CDK construct path
 * @returns A normalized construct path
 */
const normalizeCDKConstructPath = (constructPath: string): string => {
  // Don't process very long paths to avoid performance issues
  if (constructPath.length > 1000) return constructPath;

  // Handle nested stack paths
  const nestedStackRegex =
    /(?<nestedStack>[a-zA-Z0-9_]+)\.NestedStack\/\1\.NestedStackResource$/;

  return constructPath
    .replace(nestedStackRegex, '$<nestedStack>')
    .replace('/amplifyAuth/', '/')
    .replace('/amplifyData/', '/');
};

/**
 * Extracts a friendly name from a nested stack logical ID
 * @param stackName The stack name to process
 * @returns A friendly name or undefined if no match
 */
const getFriendlyNameFromNestedStackName = (
  stackName: string,
): string | undefined => {
  const parts = stackName.split('-');

  if (parts && parts.length === 7 && parts[3] === 'sandbox') {
    return parts[5].slice(0, -10) + ' stack';
  } else if (parts && parts.length === 5 && parts[3] === 'sandbox') {
    return 'root stack';
  }

  return undefined;
};

/**
 * Clean ANSI escape codes from text
 * @param text The text to clean
 * @returns The cleaned text
 */
export const cleanAnsiCodes = (text: string): string => {
  // Split the regex into parts to avoid control characters
  const ansiEscapeCodesPattern = new RegExp(
    [
      // ESC [ n ; n ; ... m
      String.fromCharCode(27) + '\\[\\d+(?:;\\d+)*m',
      // Other common ANSI sequences
      '\\[2m',
      '\\[22m',
      '\\[1m',
      '\\[36m',
      '\\[39m',
    ].join('|'),
    'g',
  );

  return text.replace(ansiEscapeCodesPattern, '');
};
/**
 * Type for parsed CloudFormation resource status
 */
export type ResourceStatus = {
  resourceType: string;
  resourceName: string;
  status: string;
  timestamp: string;
  key: string;
  statusReason?: string;
  eventId?: string;
};


import { CloudFormationClient, DescribeStackEventsCommand, StackEvent } from '@aws-sdk/client-cloudformation';
import { LogLevel, printer } from '@aws-amplify/cli-core';
import { BackendIdentifierConversions } from '@aws-amplify/platform-core';
import { BackendIdentifier } from '@aws-amplify/plugin-types';

export type CloudFormationEventDetails = {
  eventId: string;
  timestamp: Date;
  logicalId: string;
  physicalId?: string;
  resourceType: string;
  status: string;
  statusReason?: string;
  stackId: string;
  stackName: string;
};

/**
 * Service for fetching CloudFormation events directly from the AWS API
 */
export class CloudFormationEventsService {
  private cfnClient: CloudFormationClient;
  
  /**
   * Creates a new CloudFormationEventsService instance
   */
  constructor() {
    this.cfnClient = new CloudFormationClient({});
  }
  
  /**
   * Gets CloudFormation events for a stack
   * @param backendId The backend identifier
   * @param sinceTimestamp Optional timestamp to filter events that occurred after this time
   * @returns Array of CloudFormation events
   */
  async getStackEvents(backendId: BackendIdentifier, sinceTimestamp?: Date): Promise<CloudFormationEventDetails[]> {
    try {
      const stackName = BackendIdentifierConversions.toStackName(backendId);
      printer.log(`[DEBUG] Fetching CloudFormation events for stack: ${stackName}`, LogLevel.DEBUG);
      
      // Log the API call parameters
      
      const command = new DescribeStackEventsCommand({ StackName: stackName });
      
      const response = await this.cfnClient.send(command);
      
      let events = response.StackEvents || [];
      
      // Filter events by timestamp if provided
      if (sinceTimestamp) {
        const beforeCount = events.length;
        events = events.filter(event => 
          event.Timestamp && event.Timestamp > sinceTimestamp
        );
        printer.log(`Filtered events by timestamp: ${beforeCount} -> ${events.length}`, LogLevel.DEBUG);
      }
      
      const mappedEvents = events.map(event => this.mapStackEvent(event));
      
      return mappedEvents;
    } catch (error) {
      printer.log(`Error fetching CloudFormation events: ${String(error)}`, LogLevel.ERROR);
      if (error instanceof Error) {
        printer.log(`Error stack: ${error.stack}`, LogLevel.DEBUG);
      }
      return [];
    }
  }
  
  /**
   * Converts CloudFormation event details to ResourceStatus format
   * @param event The CloudFormation event details
   * @returns ResourceStatus object
   */
  convertToResourceStatus(event: CloudFormationEventDetails): ResourceStatus {
    return {
      resourceType: event.resourceType,
      resourceName: event.logicalId,
      status: event.status,
      timestamp: event.timestamp.toLocaleTimeString(),
      key: `${event.resourceType}:${event.logicalId}`,
      statusReason: event.statusReason,
      eventId: event.eventId
    };
  }

  /**
   * Maps AWS SDK StackEvent to our CloudFormationEventDetails type
   * @param event The StackEvent from AWS SDK
   * @returns CloudFormationEventDetails object
   */
  private mapStackEvent(event: StackEvent): CloudFormationEventDetails {
    return {
      eventId: event.EventId || '',
      timestamp: event.Timestamp || new Date(),
      logicalId: event.LogicalResourceId || '',
      physicalId: event.PhysicalResourceId,
      resourceType: event.ResourceType || '',
      status: event.ResourceStatus || '',
      statusReason: event.ResourceStatusReason,
      stackId: event.StackId || '',
      stackName: event.StackName || ''
    };
  }
}
